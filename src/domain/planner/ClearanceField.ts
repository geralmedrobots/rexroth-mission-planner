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

const buildField=(grid:OccupancyGrid,roundingSafe:boolean):Float32Array=>{
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
    if(roundingSafe){
      // Float32Array storage rounds the queued JavaScript number. Exact equality
      // stops propagation beyond the first neighbours on many resolutions.
      if(current.distance>result[current.index]!+1e-6)continue;
    }else if(current.distance!==result[current.index])continue;
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

/** Existing legacy distance transform, retained byte-for-byte for compatibility. */
export const buildClearanceField=(grid:OccupancyGrid):Float32Array=>buildField(grid,false);

interface CachedField { metadata: string; data: number[]; field: Float32Array }
const motionFields: CachedField[] = [];

/**
 * Same nearest-obstacle octile metric as the eight-neighbour Dijkstra above.
 * Distance propagation has no impassable cells, so two chamfer passes compute
 * it in O(width * height), without a heap entry for every map cell. Float64
 * working storage avoids cumulative Float32 rounding; the public field stays
 * Float32. Unknown cells remain zero-distance obstacle sources.
 *
 * A bounded content cache is shared by search, optimiser, metrics and replay.
 * Compare actual contents (including worker clones and in-place map updates),
 * not object identity or a mapId that can stay unchanged across revisions.
 */
export const buildMotionStateClearanceField = (grid: OccupancyGrid): Float32Array => {
  const metadata = JSON.stringify(grid.metadata);
  const cached = motionFields.find((entry) => entry.metadata === metadata &&
    entry.data.length === grid.data.length && grid.data.every((value, index) => value === entry.data[index]));
  if (cached) return cached.field;
  const { width, height, resolution, occupiedThreshold } = grid.metadata;
  const distances = new Float64Array(width * height);
  const diagonal = resolution * Math.SQRT2;
  for (let index = 0; index < distances.length; index += 1)
    distances[index] = isOccupiedValue(grid.data[index] ?? 100, occupiedThreshold) ? 0 : Infinity;
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    const i = row * width + column;
    let value = distances[i]!;
    if (column > 0) value = Math.min(value, distances[i - 1]! + resolution);
    if (row > 0) {
      value = Math.min(value, distances[i - width]! + resolution);
      if (column > 0) value = Math.min(value, distances[i - width - 1]! + diagonal);
      if (column + 1 < width) value = Math.min(value, distances[i - width + 1]! + diagonal);
    }
    distances[i] = value;
  }
  for (let row = height - 1; row >= 0; row -= 1) for (let column = width - 1; column >= 0; column -= 1) {
    const i = row * width + column;
    let value = distances[i]!;
    if (column + 1 < width) value = Math.min(value, distances[i + 1]! + resolution);
    if (row + 1 < height) {
      value = Math.min(value, distances[i + width]! + resolution);
      if (column > 0) value = Math.min(value, distances[i + width - 1]! + diagonal);
      if (column + 1 < width) value = Math.min(value, distances[i + width + 1]! + diagonal);
    }
    distances[i] = value;
  }
  const field = Float32Array.from(distances);
  motionFields.push({ metadata, data: grid.data.slice(), field });
  if (motionFields.length > 2) motionFields.shift();
  return field;
};
