import { Box, Chip, FormControlLabel, IconButton, Tooltip, Paper, Switch, Typography } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayersOutlined, RotateRight } from '@mui/icons-material';
import { useDestinationStore, type SavedDestination } from '../features/destinations/destinationStore';
import { normalizeAngle } from '../domain/geometry/angles';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import type { GridCell, RobotPose } from '../domain/types';
import { useLocatorStore } from '../features/locator/stores/locatorStore';
import { useGlobalReplanningStore } from '../features/replanning/globalReplanningStore';
import { useRecoveryStore } from '../features/recovery/recoveryStore';
import { LogService } from '../services/LogService';
import { useAppStore } from '../stores/appStore';
import {
  analyzeLiveRobotMapConversion,
  formatLivePoseMapCheck,
  getLiveRobotVisualization,
} from './mapRobotVisualization';

export type ClickMode='goal'|'start'|'waypoint'|'obstacle'|'erase'|'inspect';
interface Props { mode:ClickMode; onCell:(cell:GridCell)=>void; liveRobotPose?:RobotPose; focusedPoint?:SavedDestination }
export const MapCanvas=({mode,onCell,liveRobotPose,focusedPoint}:Props)=>{
  const canvas=useRef<HTMLCanvasElement>(null); const container=useRef<HTMLDivElement>(null);
  const lastPoseMapDiagnostic=useRef<string|undefined>(undefined);
  const [mouse,setMouse]=useState<{cell?:GridCell;world?:{x:number;y:number}}>({});
  const [view,setView]=useState({zoom:1,panX:0,panY:0});
  const [size,setSize]=useState({width:0,height:0});
  const zoomBy=useCallback((factor:number)=>setView(current=>({
    ...current,zoom:Math.max(.35,Math.min(8,current.zoom*factor)),
  })),[]);
  const [layers,setLayers]=useState({
    raw:true,baseline:true,rejected:true,optimized:false,nodes:false,corridors:true,
    explored:true,passages:true,footprints:false,turnSafety:true,
  });
  const dragging=useRef<{x:number;y:number;panX:number;panY:number}|null>(null);
  const suppressClick=useRef(false);
  const [locatorImage,setLocatorImage]=useState<HTMLImageElement>();
  const locatorRaster=useLocatorStore((state)=>state.loadedMap);
  const grid=useAppStore((s)=>s.grid); const inflated=useAppStore((s)=>s.inflatedGrid);
  const destinations=useDestinationStore(state=>state.destinations);
  const [showMarkers,setShowMarkers]=useState(true);
  useEffect(()=>{
    if(!focusedPoint||!grid||focusedPoint.mapId!==grid.metadata.mapId||!container.current)return;
    const cell=new CoordinateTransformer(grid.metadata).worldToGrid(focusedPoint.x,focusedPoint.y);
    if(!cell)return;
    const {width,height}=container.current.getBoundingClientRect();
    setView(current=>{
      const scale=Math.min(width/grid.metadata.width,height/grid.metadata.height)*current.zoom;
      return {...current,panX:(grid.metadata.width/2-cell.column-.5)*scale,
        panY:(grid.metadata.height/2-cell.row-.5)*scale};
    });
  },[focusedPoint,grid]);
  const start=useAppStore((s)=>s.start); const goal=useAppStore((s)=>s.goal);
  const raw=useAppStore((s)=>s.rawPath); const final=useAppStore((s)=>s.finalPath);
  const footprint=useAppStore((s)=>s.footprint); const showInflation=useAppStore((s)=>s.showInflation);
  const showGrid=useAppStore((s)=>s.showGrid); const rotation=useAppStore((s)=>s.viewRotation);
  const robotState=useAppStore((s)=>s.state);
  const generatedOrder=useAppStore((s)=>s.generatedOrder);
  const robotVisualization=useMemo(
    ()=>getLiveRobotVisualization(grid,liveRobotPose),
    [grid,liveRobotPose],
  );
  useEffect(()=>{
    const message = formatLivePoseMapCheck(analyzeLiveRobotMapConversion(grid, liveRobotPose));
    if (message === lastPoseMapDiagnostic.current) return;
    lastPoseMapDiagnostic.current = message;
    LogService.write('system', 'info', message);
  }, [grid, liveRobotPose]);
  const plannerResult=useAppStore((s)=>s.plannerResult);
  const plannerDiagnostics=plannerResult?.diagnostics;
  const optimizedPath=plannerResult?.simplifiedPath;
  const baselinePath=plannerResult?.baselinePath;
  const rejectedEnhancementPath=plannerResult?.rejectedEnhancementPath;
  const replanOriginal=useGlobalReplanningStore((state)=>state.runtime.originalPath);
  const replanBlocked=useGlobalReplanningStore((state)=>state.runtime.blockedPath);
  const replanNew=useGlobalReplanningStore((state)=>state.runtime.newPath);
  const temporaryObstacleCells=useGlobalReplanningStore(
    (state)=>state.runtime.temporaryObstacleCells);
  const inflatedTemporaryObstacleCells=useGlobalReplanningStore(
    (state)=>state.runtime.inflatedTemporaryObstacleCells);
  const replanExplored=useGlobalReplanningStore((state)=>state.runtime.exploredCells);
  const startProjection=useGlobalReplanningStore((state)=>state.runtime.startProjection);
  const recoveryPath=useRecoveryStore((state)=>state.runtime.reversePath);
  useEffect(()=>{
    if(!locatorRaster?.imageUrl){setLocatorImage(undefined);return;}
    const image=new Image();image.onload=()=>setLocatorImage(image);image.src=locatorRaster.imageUrl;
    return()=>{image.onload=null;};
  },[locatorRaster?.imageUrl]);
  useEffect(()=>{
    const element=canvas.current;
    if(!element)return;
    const wheel=(event:WheelEvent)=>{
      if(!event.deltaY)return;
      event.preventDefault();
      zoomBy(event.deltaY<0?1.15:.87);
    };
    element.addEventListener('wheel',wheel,{passive:false});
    return()=>element.removeEventListener('wheel',wheel);
  },[zoomBy]);
  useEffect(()=>{
    const host=container.current;
    if(!host)return;
    const measure=()=>{
      const {width,height}=host.getBoundingClientRect();
      setSize(previous=>previous.width===width&&previous.height===height?previous:{width,height});
    };
    const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(measure);
    observer?.observe(host);
    measure();
    return()=>observer?.disconnect();
  },[]);
  useEffect(()=>{
    const element=canvas.current;
    if(!element)return;
    if(!grid||!size.width||!size.height){element.width=0;return;}
    const rect=size; const dpr=devicePixelRatio; element.width=rect.width*dpr;element.height=rect.height*dpr;
    const ctx=element.getContext('2d');if(!ctx)return;ctx.scale(dpr,dpr);ctx.fillStyle='#f4f5f7';ctx.fillRect(0,0,rect.width,rect.height);
    const base=Math.min(rect.width/grid.metadata.width,rect.height/grid.metadata.height)*view.zoom;
    const ox=(rect.width-grid.metadata.width*base)/2+view.panX; const oy=(rect.height-grid.metadata.height*base)/2+view.panY;
    ctx.save();ctx.translate(rect.width/2,rect.height/2);ctx.rotate(rotation);ctx.translate(-rect.width/2,-rect.height/2);
    const useLocatorImage=Boolean(locatorImage&&locatorRaster?.mapName===grid.metadata.mapId);
    if(useLocatorImage&&locatorImage)ctx.drawImage(locatorImage,ox,oy,grid.metadata.width*base,grid.metadata.height*base);
    for(let row=0;row<grid.metadata.height;row+=1)for(let col=0;col<grid.metadata.width;col+=1){
      const i=row*grid.metadata.width+col;const value=grid.data[i]??100;
      const unknown=value<0;const occupied=value>=grid.metadata.occupiedThreshold;
      const inflatedOnly=showInflation&&(inflated?.data[i]??0)>=65&&!occupied;
      if(!useLocatorImage||inflatedOnly||unknown){
        ctx.fillStyle=inflatedOnly?'rgba(255,152,0,.42)':
          unknown?'rgba(117,117,117,.72)':occupied?'#172638':'#e8edf1';
        ctx.fillRect(ox+col*base,oy+row*base,Math.ceil(base),Math.ceil(base));
      }
    }
    if(showGrid&&base>8){ctx.strokeStyle='rgba(4,24,38,.18)';ctx.lineWidth=0.5;
      for(let c=0;c<=grid.metadata.width;c+=1){ctx.beginPath();ctx.moveTo(ox+c*base,oy);ctx.lineTo(ox+c*base,oy+grid.metadata.height*base);ctx.stroke();}
      for(let r=0;r<=grid.metadata.height;r+=1){ctx.beginPath();ctx.moveTo(ox,oy+r*base);ctx.lineTo(ox+grid.metadata.width*base,oy+r*base);ctx.stroke();}}
    if(inflatedTemporaryObstacleCells.length){
      ctx.fillStyle='rgba(255,167,38,.28)';
      inflatedTemporaryObstacleCells.forEach((cell)=>
        ctx.fillRect(ox+cell.column*base,oy+cell.row*base,Math.ceil(base),Math.ceil(base)));
    }
    if(temporaryObstacleCells.length){
      ctx.fillStyle='rgba(245,124,0,.72)';
      temporaryObstacleCells.forEach((cell)=>
        ctx.fillRect(ox+cell.column*base,oy+cell.row*base,Math.ceil(base),Math.ceil(base)));
    }
    if(layers.explored&&replanExplored.length){
      ctx.fillStyle='rgba(25,118,210,.16)';
      replanExplored.forEach((cell)=>
        ctx.fillRect(ox+cell.column*base,oy+cell.row*base,Math.ceil(base),Math.ceil(base)));
    }
    const transform=new CoordinateTransformer(grid.metadata);
    const pixel=(x:number,y:number)=>{const cell=transform.worldToGrid(x,y);return cell?{x:ox+(cell.column+.5)*base,y:oy+(cell.row+.5)*base}:null;};
    const localFootprint=footprint.source==='bosch-client-motion'&&footprint.polygon?.length
      ?footprint.polygon:[
      {x:footprint.centerOffsetX-footprint.length/2,y:footprint.centerOffsetY+footprint.width/2},
      {x:footprint.centerOffsetX+footprint.length/2,y:footprint.centerOffsetY+footprint.width/2},
      {x:footprint.centerOffsetX+footprint.length/2,y:footprint.centerOffsetY-footprint.width/2},
      {x:footprint.centerOffsetX-footprint.length/2,y:footprint.centerOffsetY-footprint.width/2},
    ];
    const drawFootprint=(point:{x:number;y:number;theta:number},color:string):void=>{
      const q=pixel(point.x,point.y);if(!q)return;
      ctx.save();ctx.translate(q.x,q.y);ctx.rotate(-point.theta);
      ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();
      localFootprint.forEach((vertex,index)=>{
        const x=vertex.x/grid.metadata.resolution*base;
        const y=-vertex.y/grid.metadata.resolution*base;
        if(index)ctx.lineTo(x,y);else ctx.moveTo(x,y);
      });
      ctx.closePath();ctx.stroke();ctx.restore();
    };
    const drawPath=(path:typeof final,color:string,width:number)=>{if(path.length<2)return;ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();
      path.forEach((p,i)=>{const q=pixel(p.x,p.y);if(q){if(i)ctx.lineTo(q.x,q.y);else ctx.moveTo(q.x,q.y);}});ctx.stroke();};
    if(layers.passages)plannerDiagnostics?.detectedPassages.forEach((passage)=>{
      const a=pixel(passage.boundaryA.x,passage.boundaryA.y);
      const b=pixel(passage.boundaryB.x,passage.boundaryB.y);
      const centre=pixel(passage.centre.x,passage.centre.y);
      const entry=pixel(passage.entry.x,passage.entry.y);
      const exit=pixel(passage.exit.x,passage.exit.y);
      if(!a||!b||!centre)return;
      ctx.strokeStyle='#00838f';ctx.lineWidth=3;ctx.beginPath();
      ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
      ctx.strokeStyle='#00acc1';ctx.setLineDash([5,3]);ctx.beginPath();
      ctx.moveTo(centre.x-Math.cos(passage.axisHeading)*30,
        centre.y+Math.sin(passage.axisHeading)*30);
      ctx.lineTo(centre.x+Math.cos(passage.axisHeading)*30,
        centre.y-Math.sin(passage.axisHeading)*30);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle='#00838f';ctx.beginPath();ctx.arc(centre.x,centre.y,5,0,Math.PI*2);ctx.fill();
      if(entry){ctx.fillStyle='#7b1fa2';ctx.beginPath();ctx.arc(entry.x,entry.y,5,0,Math.PI*2);ctx.fill();}
      if(exit){ctx.fillStyle='#2e7d32';ctx.beginPath();ctx.arc(exit.x,exit.y,5,0,Math.PI*2);ctx.fill();}
      ctx.fillStyle='#071a2b';ctx.font='10px sans-serif';
      ctx.fillText(`${passage.widthM.toFixed(2)} m / req ${(
        footprint.width+2*(useAppStore.getState().plannerOptions.passageSafety
          .planningSafetyMarginM+useAppStore.getState().plannerOptions.passageSafety
          .localizationMarginM)).toFixed(2)} m`,centre.x+7,centre.y-7);
    });
    if(layers.corridors)generatedOrder?.edges.forEach((edge,index)=>{
      const corridor=edge.corridor;const startNode=generatedOrder.nodes[index]?.nodePosition;
      const endNode=generatedOrder.nodes[index+1]?.nodePosition;
      if(!corridor||!startNode||!endNode)return;
      const angle=Math.atan2(endNode.y-startNode.y,endNode.x-startNode.x);
      const normal={x:-Math.sin(angle),y:Math.cos(angle)};
      const world=[
        {x:startNode.x+normal.x*corridor.leftWidth,y:startNode.y+normal.y*corridor.leftWidth},
        {x:endNode.x+normal.x*corridor.leftWidth,y:endNode.y+normal.y*corridor.leftWidth},
        {x:endNode.x-normal.x*corridor.rightWidth,y:endNode.y-normal.y*corridor.rightWidth},
        {x:startNode.x-normal.x*corridor.rightWidth,y:startNode.y-normal.y*corridor.rightWidth},
      ];
      const points=world.map((point)=>pixel(point.x,point.y));
      if(points.some((point)=>!point))return;
      const valid=points as Array<{x:number;y:number}>;
      ctx.fillStyle='rgba(200,16,46,.12)';ctx.strokeStyle='rgba(143,11,34,.62)';
      ctx.lineWidth=1.5;ctx.setLineDash([6,4]);ctx.beginPath();
      valid.forEach((point,pointIndex)=>pointIndex?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));
      ctx.closePath();ctx.fill();ctx.stroke();ctx.setLineDash([]);
    });
    if(layers.raw)drawPath(raw,'rgba(200,16,46,.30)',2);
    if(layers.baseline&&baselinePath)drawPath(baselinePath,'#16875f',4);
    if(layers.rejected&&rejectedEnhancementPath?.length){
      ctx.setLineDash([8,5]);
      drawPath(rejectedEnhancementPath,'#ef6c00',3);
      ctx.setLineDash([]);
    }
    if(layers.optimized&&optimizedPath)drawPath(optimizedPath,'#1565c0',3);
    if(replanOriginal.length)drawPath(replanOriginal,'rgba(95,105,115,.75)',4);
    if(replanBlocked.length)drawPath(replanBlocked,'#d32f2f',5);
    if(replanNew.length)drawPath(replanNew,'#1b8f4d',5);
    else drawPath(final,'#c8102e',5);
    if(recoveryPath.length)drawPath(recoveryPath,'#7b1fa2',6);
    for(let i=0;i<final.length-1;i+=1){const a=pixel(final[i]!.x,final[i]!.y);const b=pixel(final[i+1]!.x,final[i+1]!.y);
      if(!a||!b)continue;const angle=Math.atan2(b.y-a.y,b.x-a.x);const x=(a.x+b.x)/2,y=(a.y+b.y)/2;
      ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.fillStyle='#f4fafc';ctx.beginPath();
      ctx.moveTo(7,0);ctx.lineTo(-4,-4);ctx.lineTo(-4,4);ctx.closePath();ctx.fill();ctx.restore();}
    if(layers.nodes)generatedOrder?.nodes.forEach((node,i)=>{const q=pixel(node.nodePosition.x,node.nodePosition.y);if(!q)return;ctx.fillStyle='#fff';ctx.strokeStyle='#c8102e';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(q.x,q.y,5,0,Math.PI*2);ctx.fill();ctx.stroke();
      const theta=node.nodePosition.theta;
      if(theta!==undefined){ctx.beginPath();ctx.moveTo(q.x,q.y);ctx.lineTo(q.x+Math.cos(theta)*14,q.y-Math.sin(theta)*14);ctx.stroke();}
      ctx.fillStyle='#071a2b';ctx.font='10px sans-serif';ctx.fillText(String(i),q.x+7,q.y-7);});
    if(layers.footprints)final.forEach((point)=>
      drawFootprint(point,'rgba(21,101,192,.55)'));
    if(layers.turnSafety)plannerDiagnostics?.rejectedTurnLocations.forEach((point)=>{
      const q=pixel(point.x,point.y);if(!q)return;
      const radius=Math.max(...localFootprint.map((point)=>Math.hypot(point.x,point.y)))/
        grid.metadata.resolution*base;
      ctx.fillStyle='rgba(211,47,47,.16)';ctx.strokeStyle='#d32f2f';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(q.x,q.y,radius,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.beginPath();ctx.moveTo(q.x-7,q.y-7);ctx.lineTo(q.x+7,q.y+7);
      ctx.moveTo(q.x+7,q.y-7);ctx.lineTo(q.x-7,q.y+7);ctx.stroke();
    });
    if(goal){const q=pixel(goal.x,goal.y);if(q){ctx.strokeStyle='#c8102e';ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(q.x,q.y,13,0,Math.PI*2);ctx.stroke();ctx.fillStyle='rgba(0,191,234,.25)';
      ctx.beginPath();ctx.arc(q.x,q.y,8,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.font='bold 11px sans-serif';ctx.fillText('DESTINATION',q.x+18,q.y-12);}}
    if(robotVisualization.status==='visible'&&liveRobotPose){const q=pixel(liveRobotPose.x,liveRobotPose.y);if(q){const warning=robotState?.safetyState?.eStop!=='NONE'||(robotState?.errors?.length??0)>0;
      const color=warning?'#8f0b22':robotState?.driving?'#16875f':'#c8102e';ctx.save();ctx.translate(q.x,q.y);ctx.rotate(-liveRobotPose.theta);
      ctx.fillStyle=color;ctx.strokeStyle='#f4fafc';ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(-11,-8,22,16,5);ctx.fill();ctx.stroke();
      ctx.fillStyle='#f4fafc';ctx.beginPath();ctx.moveTo(14,0);ctx.lineTo(6,-5);ctx.lineTo(6,5);ctx.closePath();ctx.fill();ctx.restore();
      ctx.strokeStyle=liveRobotPose.positionInitialized?'rgba(56,217,150,.8)':'rgba(244,185,66,.8)';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(q.x,q.y,18,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#fff';ctx.font='bold 11px sans-serif';ctx.fillText('PHARMAROBOT',q.x+22,q.y-13);}}
    if(startProjection?.projectedPose){
      const q=pixel(startProjection.projectedPose.x,startProjection.projectedPose.y);
      if(q){
        ctx.fillStyle='#7b1fa2';ctx.strokeStyle='#fff';ctx.lineWidth=2;
        ctx.beginPath();ctx.arc(q.x,q.y,7,0,Math.PI*2);ctx.fill();ctx.stroke();
        ctx.fillStyle='#071a2b';ctx.font='bold 10px sans-serif';
        ctx.fillText('A* START',q.x+10,q.y-8);
      }
    }
    if(showMarkers){
      for(const point of destinations){
        if(point.mapId!==grid.metadata.mapId)continue;
        const q=pixel(point.x,point.y);
        if(!q)continue;
        ctx.save();ctx.translate(q.x,q.y);ctx.rotate(-rotation);
        ctx.fillStyle='#922341';ctx.strokeStyle='#fff';ctx.lineWidth=2;
        ctx.beginPath();ctx.arc(0,0,5,0,Math.PI*2);ctx.fill();ctx.stroke();
        ctx.font='600 12px "Segoe UI",sans-serif';ctx.lineWidth=3;
        ctx.strokeText(point.displayName,9,-5);ctx.fillStyle='#262432';ctx.fillText(point.displayName,9,-5);
        ctx.restore();
      }
    }
    if(start)drawFootprint(start,'#1565c0');
    ctx.restore();
  },[grid,destinations,showMarkers,inflated,start,goal,raw,final,footprint,showInflation,showGrid,rotation,view,size,
    locatorImage,locatorRaster,layers,robotState,generatedOrder,replanOriginal,replanBlocked,
    replanNew,temporaryObstacleCells,inflatedTemporaryObstacleCells,
    replanExplored,startProjection,recoveryPath,plannerDiagnostics,optimizedPath,
    baselinePath,rejectedEnhancementPath,liveRobotPose,robotVisualization]);
  const cellFromEvent=(event:React.MouseEvent<HTMLCanvasElement>):GridCell|null=>{
    if(!grid||!canvas.current)return null;const rect=canvas.current.getBoundingClientRect();
    const base=Math.min(rect.width/grid.metadata.width,rect.height/grid.metadata.height)*view.zoom;
    const ox=(rect.width-grid.metadata.width*base)/2+view.panX;const oy=(rect.height-grid.metadata.height*base)/2+view.panY;
    const cx=rect.width/2,cy=rect.height/2;const dx=event.clientX-rect.left-cx,dy=event.clientY-rect.top-cy;
    const c=Math.cos(-rotation),s=Math.sin(-rotation);const sx=c*dx-s*dy+cx,sy=s*dx+c*dy+cy;
    const cell={column:Math.floor((sx-ox)/base),row:Math.floor((sy-oy)/base)};
    return cell.row>=0&&cell.column>=0&&cell.row<grid.metadata.height&&cell.column<grid.metadata.width?cell:null;
  };
  return <Box sx={{display:'flex',flexDirection:'column',flex:'1 0 auto',minWidth:0,bgcolor:'#f4f5f7'}}>
    <Paper role="group" aria-label="Map layers" className="mr-glass" sx={{px:1,flexShrink:0}}>
      <details className="mr-layers"><summary><LayersOutlined fontSize="small"/>Map layers</summary><div className="mr-layer-options">
      <FormControlLabel control={<Switch size="small" checked={showGrid} onChange={e=>useAppStore.getState().set({showGrid:e.target.checked})}/>} label="Grid"/>
      <FormControlLabel control={<Switch size="small" checked={showInflation} onChange={e=>useAppStore.getState().set({showInflation:e.target.checked})}/>} label="Inflated obstacles"/>
      <FormControlLabel control={<Switch size="small" checked={showMarkers} onChange={e=>setShowMarkers(e.target.checked)}/>} label="Waypoint markers"/>
      <FormControlLabel control={<Switch size="small" checked={layers.raw}
        onChange={(event)=>setLayers((value)=>({...value,raw:event.target.checked}))}/>} label="Raw A*"/>
      <FormControlLabel control={<Switch size="small" checked={layers.baseline}
        onChange={(event)=>setLayers((value)=>({...value,baseline:event.target.checked}))}/>}
        label="Valid baseline"/>
      <FormControlLabel control={<Switch size="small" checked={layers.rejected}
        onChange={(event)=>setLayers((value)=>({...value,rejected:event.target.checked}))}/>}
        label="Rejected enhancement"/>
      <FormControlLabel control={<Switch size="small" checked={layers.optimized}
        onChange={(event)=>setLayers((value)=>({...value,optimized:event.target.checked}))}/>}
        label="Optimized path"/>
      <FormControlLabel control={<Switch size="small" checked={layers.nodes}
        onChange={(event)=>setLayers((value)=>({...value,nodes:event.target.checked}))}/>} label="VDA nodes"/>
      <FormControlLabel control={<Switch size="small" checked={layers.corridors}
        onChange={(event)=>setLayers((value)=>({...value,corridors:event.target.checked}))}/>}
        label="Bypass corridors"/>
      <FormControlLabel control={<Switch size="small" checked={layers.explored}
        onChange={(event)=>setLayers((value)=>({...value,explored:event.target.checked}))}/>}
        label="A* explored cells"/>
      <FormControlLabel control={<Switch size="small" checked={layers.passages}
        onChange={(event)=>setLayers((value)=>({...value,passages:event.target.checked}))}/>}
        label="Doors and alignment"/>
      <FormControlLabel control={<Switch size="small" checked={layers.footprints}
        onChange={(event)=>setLayers((value)=>({...value,footprints:event.target.checked}))}/>}
        label="Bosch footprint at nodes"/>
      <FormControlLabel control={<Switch size="small" checked={layers.turnSafety}
        onChange={(event)=>setLayers((value)=>({...value,turnSafety:event.target.checked}))}/>}
        label="Swept / rejected turns"/>
      </div></details>
    </Paper>
    <Box ref={container} sx={{position:'relative',flex:'1 0 180px',minHeight:180,overflow:'hidden'}}>
    {!grid&&<Box className="mr-map-empty"><Typography variant="h2">No planning map</Typography><Typography variant="body2">Open Map to load from Locator, or import a file in Map setup.</Typography></Box>}
    <canvas ref={canvas} aria-label="Planning map" onClick={(e)=>{
      if(suppressClick.current){suppressClick.current=false;return;}
      const cell=cellFromEvent(e);if(cell)onCell(cell);
    }}
      onMouseDown={(event)=>{
        suppressClick.current=false;
        dragging.current={x:event.clientX,y:event.clientY,panX:view.panX,panY:view.panY};
      }}
      onMouseUp={()=>{dragging.current=null;}}
      onMouseLeave={()=>{dragging.current=null;setMouse({});}}
      onMouseMove={(e)=>{
        const drag=dragging.current;
        if(drag){
          const deltaX=e.clientX-drag.x;const deltaY=e.clientY-drag.y;
          if(Math.hypot(deltaX,deltaY)>3)suppressClick.current=true;
          setView((current)=>({...current,panX:drag.panX+deltaX,panY:drag.panY+deltaY}));
          return;
        }
        const cell=cellFromEvent(e);if(grid&&cell){
          const p=new CoordinateTransformer(grid.metadata).gridToWorld(cell.row,cell.column);
          setMouse({cell,world:p});
        }else setMouse({});
      }}
      onContextMenu={(event)=>{
        event.preventDefault();
        const cell=cellFromEvent(event);
        setMouse(cell&&grid?{cell,world:new CoordinateTransformer(grid.metadata).gridToWorld(cell.row,cell.column)}:{});
      }}
      style={{display:'block',position:'absolute',inset:0,width:'100%',height:'100%',
        filter:'contrast(var(--mr-map-contrast, 1))',cursor:'crosshair'}}/>
    </Box>
    <Box role="group" aria-label="Map position and zoom" className="mr-map-footer" sx={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:.5,p:.75}}>
      <Chip size="small" label={`Mode: ${mode}`} color="primary"/>
      <Chip size="small" label={robotVisualization.label}
        color={robotVisualization.status==='visible'?'success':
          robotVisualization.status==='outside-map'?'warning':'default'}/>
      <Chip size="small" label={mouse.cell?`Grid ${mouse.cell.column}, ${mouse.cell.row}`:'Grid —'}/>
      <Chip size="small" label={mouse.world?`World ${mouse.world.x.toFixed(3)}, ${mouse.world.y.toFixed(3)} m`:'World —'}/>
      <Box sx={{flex:1}}/>
      <Tooltip title="Rotate view"><IconButton size="small" aria-label="Rotate view"
        onClick={()=>useAppStore.getState().set({viewRotation:normalizeAngle(rotation+Math.PI/2)})}><RotateRight fontSize="small"/></IconButton></Tooltip>
      <Chip size="small" clickable label="−" aria-label="Zoom out" onClick={()=>zoomBy(1/1.2)}/>
      <Chip size="small" label={`${Math.round(view.zoom*100)}%`}/>
      <Chip size="small" clickable label="+" aria-label="Zoom in" onClick={()=>zoomBy(1.2)}/>
      <Chip size="small" clickable label="Fit" aria-label="Fit map" onClick={()=>setView({zoom:1,panX:0,panY:0})}/>
    </Box>
  </Box>;
};
