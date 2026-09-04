import type { TemporaryObstacleObservation } from '../replanning/types';

export interface RearLaserStatus {
  count:number;
  fresh:boolean;
  newestReceiveTime:number|null;
}

export const getRearLaserStatus=(
  observations:TemporaryObstacleObservation[],
  staleTimeoutMs:number,
  nowMs=Date.now(),
):RearLaserStatus=>{
  const rear=observations.filter((observation)=>observation.source==='Laser2');
  const newest=rear.reduce<number|null>((latest,observation)=>
    latest===null||observation.receivedAtMs>latest?observation.receivedAtMs:latest,null);
  return {
    count:rear.length,newestReceiveTime:newest,
    fresh:newest!==null&&nowMs-newest<=staleTimeoutMs,
  };
};
