/// <reference types="vite/client" />
interface Window {
  rokitDesktop?: {
    saveConfig(data:string):Promise<void>; loadConfig():Promise<string|null>; protectSecret(value:string):Promise<string>;
  };
}
