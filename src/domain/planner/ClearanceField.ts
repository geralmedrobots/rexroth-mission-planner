import type { OccupancyGrid } from '../types';
import { isOccupiedValue } from './ObstacleInflation';

interface HeapItem { index:number; distance:number }

class DistanceHeap {
  private readonly items:HeapItem[]=[];
  public push(item:HeapItem):void{
    this.items.push(item);
    let index=this.items.length-1;
    while(index>0){
      const parent=Math.floor((index-1)/2);
      if(this.items[parent]!.distance<=item.distance)break;
      this.items[index]=this.items[parent]!;
      index=parent;
    }
    this.items[index]=item;
  }
  public pop():HeapItem|undefined{
    const first=this.items[0];
    const last=this.items.pop();
    if(!first||!last||this.items.length===0)return first;
    let index=0;
    while(true){
      const left=index*2+1;
      if(left>=this.items.length)break;
      const right=left+1;
      const child=right<this.items.length&&
        this.items[right]!.distance<this.items[left]!.distance?right:left;
      if(this.items[child]!.distance>=last.distance)break;
      this.items[index]=this.items[child]!;
      index=child;
    }
    this.items[index]=last;
    return first;
  }
  public get size():number{return this.items.length;}
}

/** Eight-neighbour Euclidean distance transform in metres. Unknown is occupied. */
export const buildClearanceField=(grid:OccupancyGrid):Float32Array=>{
  const {width,height,resolution,occupiedThreshold}=grid.metadata;
  const result=new Float32Array(width*height).fill(Number.POSITIVE_INFINITY);
  const heap=new DistanceHeap();
  grid.data.forEach((value,index)=>{
    if(isOccupiedValue(value,occupiedThreshold)){
      result[index]=0;
      heap.push({index,distance:0});
    }
  });
  const moves=[
    [-1,0,1],[1,0,1],[0,-1,1],[0,1,1],
    [-1,-1,Math.SQRT2],[-1,1,Math.SQRT2],[1,-1,Math.SQRT2],[1,1,Math.SQRT2],
  ] as const;
  while(heap.size){
    const current=heap.pop()!;
    if(current.distance!==result[current.index])continue;
    const row=Math.floor(current.index/width);
    const column=current.index%width;
    for(const [dr,dc,scale] of moves){
      const nextRow=row+dr;
      const nextColumn=column+dc;
      if(nextRow<0||nextColumn<0||nextRow>=height||nextColumn>=width)continue;
      const next=nextRow*width+nextColumn;
      const distance=current.distance+scale*resolution;
      if(distance>=result[next]!)continue;
      result[next]=distance;
      heap.push({index:next,distance});
    }
  }
  return result;
};
