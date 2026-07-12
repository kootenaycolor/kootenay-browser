/**
 * DIY auto-updater for unsigned, DMG-distributed builds.
 *
 * macOS's built-in Squirrel updater requires an Apple Developer ID signature,
 * which an ad-hoc-signed app doesn't have. So instead we:
 *   1. poll the repo's GitHub "latest release" for a newer version tag,
 *   2. download the release's `.app` zip,
 *   3. strip the Gatekeeper quarantine xattr (so an unsigned app still runs),
 *   4. swap the bundle in place, and
 *   5. relaunch.
 * Any failure (no write permission, network, bad archive) falls back to
 * opening the release page for a manual DMG drag-install.
 *
 * The target repo is read from package.json `updateRepo` ("owner/name"). The
 * literal placeholder "OWNER/REPO" means updates are unconfigured — the module
 * no-ops cleanly.
 */

import { app, net, dialog, shell, Notification, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

interface ReleaseInfo {
  version: string;
  notes: string;
  zipUrl: string;
  htmlUrl: string;
}

function repoSlug(): string | null {
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    const slug = pkg.updateRepo as string | undefined;
    return slug && slug !== 'OWNER/REPO' ? slug : null;
  } catch {
    return null;
  }
}

/** "v1.2.3" | "1.2.3" → [1,2,3]; compares numerically, missing parts = 0. */
export function cmpVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export async function fetchLatest(): Promise<ReleaseInfo | null> {
  const slug = repoSlug();
  if (!slug) return null;
  const res = await net.fetch(
    `https://api.github.com/repos/${slug}/releases/latest`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) return null;
  const rel = (await res.json()) as {
    tag_name: string;
    body?: string;
    html_url: string;
    assets: { name: string; browser_download_url: string }[];
    draft?: boolean;
    prerelease?: boolean;
  };
  if (rel.draft) return null;
  const zip = rel.assets.find((a) => /mac.*\.zip$|\.app\.zip$/i.test(a.name))
    ?? rel.assets.find((a) => a.name.endsWith('.zip'));
  if (!zip) return null;
  return {
    version: rel.tag_name.replace(/^v/, ''),
    notes: rel.body?.trim() || '',
    zipUrl: zip.browser_download_url,
    htmlUrl: rel.html_url,
  };
}

/** Path to the running .app bundle (…/Kootenay Browser.app). */
function currentAppBundle(): string | null {
  // exe = …/Kootenay Browser.app/Contents/MacOS/Kootenay Browser
  const exe = app.getPath('exe');
  const idx = exe.indexOf('.app/');
  return idx === -1 ? null : exe.slice(0, idx + 4);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err}`)),
    );
  });
}

async function downloadZip(url: string, dest: string): Promise<void> {
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    Readable.fromWeb(res.body as never)
      .pipe(out)
      .on('finish', () => resolve())
      .on('error', reject);
  });
}

async function installUpdate(info: ReleaseInfo): Promise<void> {
  const bundle = currentAppBundle();
  if (!bundle) throw new Error('cannot locate app bundle');

  const work = path.join(app.getPath('temp'), 'kc-update');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const zipPath = path.join(work, 'update.zip');

  new Notification({
    title: 'Kootenay Browser',
    body: `Downloading version ${info.version}…`,
  }).show();

  await downloadZip(info.zipUrl, zipPath);

  // ditto handles .app resource forks correctly (unlike unzip).
  const extractDir = path.join(work, 'extract');
  fs.mkdirSync(extractDir);
  await run('ditto', ['-x', '-k', zipPath, extractDir]);

  const newApp = findApp(extractDir);
  if (!newApp) throw new Error('no .app inside update zip');

  // Let an unsigned/ad-hoc app launch after download.
  await run('xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => {});

  // Swap bundles, keeping a backup to roll back on failure.
  const backup = bundle + '.old';
  fs.rmSync(backup, { recursive: true, force: true });
  fs.renameSync(bundle, backup);
  try {
    await run('ditto', [newApp, bundle]);
  } catch (e) {
    fs.rmSync(bundle, { recursive: true, force: true });
    fs.renameSync(backup, bundle); // restore
    throw e;
  }
  fs.rmSync(backup, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });

  app.relaunch();
  app.exit(0);
}

function findApp(dir: string): string | null {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.app')) return path.join(dir, name);
  }
  return null;
}

/** User-facing check. `silent` skips the "you're up to date" dialog. */
export async function checkForUpdates(silent = false): Promise<void> {
  const parent = BrowserWindow.getAllWindows()[0];
  let info: ReleaseInfo | null;
  try {
    info = await fetchLatest();
  } catch {
    if (!silent) {
      dialog.showMessageBox({ message: 'Could not check for updates.', type: 'warning' });
    }
    return;
  }
  if (!info) {
    if (!silent) {
      dialog.showMessageBox({
        message: repoSlug()
          ? 'No published release found yet.'
          : 'Updates are not configured for this build.',
        type: 'info',
      });
    }
    return;
  }
  if (cmpVersions(info.version, app.getVersion()) <= 0) {
    if (!silent) {
      dialog.showMessageBox({
        message: `You're up to date (version ${app.getVersion()}).`,
        type: 'info',
      });
    }
    return;
  }

  const notes = info.notes ? `\n\n${info.notes.slice(0, 600)}` : '';
  const choice = dialog.showMessageBoxSync(parent, {
    type: 'info',
    buttons: ['Install & Relaunch', 'Release Notes', 'Later'],
    defaultId: 0,
    cancelId: 2,
    message: `Kootenay Browser ${info.version} is available.`,
    detail: `You have ${app.getVersion()}.${notes}`,
  });
  if (choice === 1) {
    shell.openExternal(info.htmlUrl);
    return;
  }
  if (choice !== 0) return;

  try {
    await installUpdate(info);
  } catch (err) {
    // couldn't self-install (permissions, etc.) → manual path
    const c = dialog.showMessageBoxSync(parent, {
      type: 'warning',
      buttons: ['Open Download Page', 'Cancel'],
      defaultId: 0,
      message: 'Automatic update failed.',
      detail:
        `${String((err as Error).message ?? err)}\n\n` +
        'You can download the new version and drag it to Applications.',
    });
    if (c === 0) shell.openExternal(info.htmlUrl);
  }
}

/** Silent check a few seconds after launch, then once a day. */
export function startAutoUpdate(): void {
  if (!repoSlug()) return;
  setTimeout(() => void checkForUpdates(true), 6000);
  setInterval(() => void checkForUpdates(true), 24 * 60 * 60 * 1000);
}
