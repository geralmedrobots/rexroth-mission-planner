import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('rokitDesktop',{
  saveConfig:(data:string)=>ipcRenderer.invoke('config:save',data) as Promise<void>,
  loadConfig:()=>ipcRenderer.invoke('config:load') as Promise<string|null>,
  protectSecret:(value:string)=>ipcRenderer.invoke('secret:protect',value) as Promise<string>,
});
