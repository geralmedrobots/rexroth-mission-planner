import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const directory = dirname(fileURLToPath(import.meta.url)); let bridge:ChildProcess|undefined;
const createWindow = ():void => {
  const window=new BrowserWindow({
    width:1600,height:1000,minWidth:1180,minHeight:720,
    webPreferences:{preload:join(directory,'preload.js'),contextIsolation:true,nodeIntegration:false},
  });
  const dev=process.env.VITE_DEV_SERVER_URL;
  if(dev) void window.loadURL(dev); else void window.loadFile(join(directory,'../../dist/index.html'));
};
app.whenReady().then(()=>{
  if(!process.env.VITE_DEV_SERVER_URL) bridge=fork(join(directory,'../server/index.js'),[],{stdio:'inherit'});
  ipcMain.handle('config:save',async(_event,data:string)=>{
    const result=await dialog.showSaveDialog({defaultPath:'rokit-planner-settings.json',filters:[{name:'JSON',extensions:['json']}]});
    if(!result.canceled&&result.filePath) await writeFile(result.filePath,data,'utf8');
  });
  ipcMain.handle('config:load',async()=>{
    const result=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});
    return result.canceled||!result.filePaths[0]?null:readFile(result.filePaths[0],'utf8');
  });
  ipcMain.handle('secret:protect',(_event,value:string)=>safeStorage.isEncryptionAvailable()?safeStorage.encryptString(value).toString('base64'):'');
  createWindow(); app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
});
app.on('window-all-closed',()=>{bridge?.kill();if(process.platform!=='darwin')app.quit();});
