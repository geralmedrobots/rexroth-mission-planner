import type { StartupOperation, StartupSnapshot } from './types';

const abortError=():DOMException=>new DOMException('Startup cancelled.','AbortError');
const delay=(milliseconds:number,signal:AbortSignal):Promise<void>=>new Promise((resolve,reject)=>{
  const timer=setTimeout(resolve,milliseconds);
  signal.addEventListener('abort',()=>{clearTimeout(timer);reject(abortError());},{once:true});
});

export class StartupConnectionManager {
  private controller?:AbortController;
  public cancel():void { this.controller?.abort();this.controller=undefined; }

  public async start(
    operations:StartupOperation[],
    report:(snapshot:StartupSnapshot)=>void,
  ):Promise<void>{
    this.cancel();
    const controller=new AbortController();this.controller=controller;
    report({phase:'INITIALIZING',message:'Preparing navigation control…',retryAttempt:0,running:true});
    try{
      let degraded=false;
      const optionalFailures:string[]=[];
      for(const operation of operations){
        const maxAttempts=(operation.retries??0)+1;
        let completed=false;
        for(let attempt=1;attempt<=maxAttempts&&!completed;attempt+=1){
          if(controller.signal.aborted)throw abortError();
          report({phase:operation.phase,message:operation.message,retryAttempt:attempt-1,running:true});
          try{await operation.run(controller.signal);completed=true;}
          catch(error){
            if(controller.signal.aborted)throw abortError();
            if(attempt<maxAttempts)await delay(Math.min(8_000,500*2**(attempt-1)),controller.signal);
            else if(operation.optional){
              degraded=true;completed=true;
              const reason=error instanceof Error?error.message:String(error);
              optionalFailures.push(`${operation.phase.replaceAll('_',' ')}: ${reason}`);
            }
            else throw error;
          }
        }
      }
      report({
        phase:degraded?'DEGRADED':'READY',
        message:degraded?'Operator attention is required for one or more services.':'Navigation services are ready.',
        retryAttempt:0,running:false,
        error:optionalFailures.length?optionalFailures.join('\n'):undefined,
      });
    }catch(error){
      if(error instanceof DOMException&&error.name==='AbortError')return;
      report({phase:'ERROR',message:'Startup could not be completed.',retryAttempt:0,running:false,
        error:error instanceof Error?error.message:String(error)});
    }finally{if(this.controller===controller)this.controller=undefined;}
  }
}

export const startupConnectionManager=new StartupConnectionManager();
