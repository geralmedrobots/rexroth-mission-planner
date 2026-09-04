import type { OccupancyGrid } from '../../domain/types';
export const createSampleMap = ():OccupancyGrid => {
  const width=72; const height=44; const data=new Array<number>(width*height).fill(0);
  const obstacle=(r0:number,c0:number,r1:number,c1:number):void=>{
    for(let row=r0;row<=r1;row+=1)for(let col=c0;col<=c1;col+=1)data[row*width+col]=100;
  };
  obstacle(0,0,1,width-1); obstacle(height-2,0,height-1,width-1);
  obstacle(0,0,height-1,1); obstacle(0,width-2,height-1,width-1);
  obstacle(8,19,35,22); obstacle(8,45,35,48);
  obstacle(8,23,11,34); obstacle(32,34,35,44);
  return {metadata:{name:'Example warehouse',mapId:'sample-warehouse',width,height,resolution:0.1,
    origin:{x:-3.6,y:-2.2,yaw:0},occupiedThreshold:0.65,freeThreshold:0.196,negate:false},data};
};
