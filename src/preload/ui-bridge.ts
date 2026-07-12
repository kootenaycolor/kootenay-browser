import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kc', {
  send: (channel: string, ...args: unknown[]) => {
    ipcRenderer.send(channel, ...args);
  },
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),
  onState: (cb: (state: unknown) => void) => {
    ipcRenderer.on('kc:state', (_e, state) => cb(state));
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
