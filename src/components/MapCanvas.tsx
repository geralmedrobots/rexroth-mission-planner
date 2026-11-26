import {
  Box, Button, Chip, FormControlLabel, IconButton, Paper, Stack, Switch, Tooltip, Typography,
  useTheme,
} from '@mui/material';
import {
  CenterFocusStrong, Fullscreen, Layers, ZoomIn, ZoomOut,
} from '@mui/icons-material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CoordinateTransformer } from '../domain/geometry/CoordinateTransformer';
import type { GridCell, RobotPose } from '../domain/types';
import { useLocatorStore } from '../features/locator/stores/locatorStore';
import { useDestinationStore } from '../features/destinations/destinationStore';
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
interface Props { mode:ClickMode; onCell:(cell:GridCell)=>void; liveRobotPose?:RobotPose }
export const MapCanvas=({mode,onCell,liveRobotPose}:Props)=>{
  const theme=useTheme();
  const isDark=theme.palette.mode==='dark';
  const canvas=useRef<HTMLCanvasElement>(null); const container=useRef<HTMLDivElement>(null);
  const lastPoseMapDiagnostic=useRef<string|undefined>(undefined);
  const [mouse,setMouse]=useState<{cell?:GridCell;world?:{x:number;y:number}}>({});
  const [view,setView]=useState({zoom:1,panX:0,panY:0});
  const [resizeVersion,setResizeVersion]=useState(0);
  const [showLayers,setShowLayers]=useState(false);
  const [fullscreenError,setFullscreenError]=useState<string>();
  const [layers,setLayers]=useState({
    raw:true,baseline:true,rejected:true,optimized:false,nodes:false,corridors:true,
    explored:true,passages:true,footprints:false,turnSafety:true,
  });
  const dragging=useRef<{x:number;y:number;panX:number;panY:number}|null>(null);
  const suppressClick=useRef(false);
  const [locatorImage,setLocatorImage]=useState<HTMLImageElement>();
  const locatorRaster=useLocatorStore((state)=>state.loadedMap);
  const grid=useAppStore((s)=>s.grid); const inflated=useAppStore((s)=>s.inflatedGrid);
  const start=useAppStore((s)=>s.start); const goal=useAppStore((s)=>s.goal);
  const raw=useAppStore((s)=>s.rawPath); const final=useAppStore((s)=>s.finalPath);
  const footprint=useAppStore((s)=>s.footprint); const showInflation=useAppStore((s)=>s.showInflation);
  const showGrid=useAppStore((s)=>s.showGrid); const rotation=useAppStore((s)=>s.viewRotation);
  const robotState=useAppStore((s)=>s.state);
  const savedDestinations=useDestinationStore((state)=>state.destinations);
  const generatedOrder=useAppStore((s)=>s.generatedOrder);
  const robotVisualization=useMemo(
    ()=>getLiveRobotVisualization(grid,liveRobotPose),
    [grid,liveRobotPose],
  );
  useEffect(()=>{
    const host=container.current;
    if(!host)return;
    const observer=new ResizeObserver(()=>setResizeVersion((version)=>version+1));
    observer.observe(host);
    return()=>observer.disconnect();
  },[]);
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
  const visibleDestinations=savedDestinations.filter((destination)=>
    destination.enabled&&destination.mapId===grid?.metadata.mapId);
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
    const element=canvas.current; const host=container.current;if(!element||!host||!grid)return;
    const rect=host.getBoundingClientRect(); const dpr=devicePixelRatio; element.width=rect.width*dpr;element.height=rect.height*dpr;
    element.style.width=`${rect.width}px`;element.style.height=`${rect.height}px`;
    const ctx=element.getContext('2d');if(!ctx)return;ctx.scale(dpr,dpr);
    ctx.fillStyle=isDark?'#050D18':'#f4f5f7';ctx.fillRect(0,0,rect.width,rect.height);
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
          unknown?(isDark?'rgba(71,85,105,.78)':'rgba(117,117,117,.72)'):
            occupied?(isDark?'#dbe7f0':'#172638'):(isDark?'#10263A':'#e8edf1');
        ctx.fillRect(ox+col*base,oy+row*base,Math.ceil(base),Math.ceil(base));
      }
    }
    if(showGrid&&base>8){ctx.strokeStyle=isDark?'rgba(148,163,184,.16)':'rgba(4,24,38,.18)';ctx.lineWidth=0.5;
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
      ctx.fillStyle=isDark?'#F1F5F9':'#071a2b';ctx.font='10px sans-serif';
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
    if(layers.raw)drawPath(raw,isDark?'rgba(148,163,184,.42)':'rgba(200,16,46,.30)',2);
    if(layers.baseline&&baselinePath)drawPath(baselinePath,'#16875f',4);
    if(layers.rejected&&rejectedEnhancementPath?.length){
      ctx.setLineDash([8,5]);
      drawPath(rejectedEnhancementPath,'#ef6c00',3);
      ctx.setLineDash([]);
    }
    if(layers.optimized&&optimizedPath)drawPath(optimizedPath,isDark?'#007BFF':'#1565c0',3);
    if(replanOriginal.length)drawPath(replanOriginal,'rgba(95,105,115,.75)',4);
    if(replanBlocked.length)drawPath(replanBlocked,'#d32f2f',5);
    if(replanNew.length)drawPath(replanNew,'#1b8f4d',5);
    else drawPath(final,isDark?'#00B8F0':'#c8102e',5);
    if(recoveryPath.length)drawPath(recoveryPath,'#7b1fa2',6);
    for(let i=0;i<final.length-1;i+=1){const a=pixel(final[i]!.x,final[i]!.y);const b=pixel(final[i+1]!.x,final[i+1]!.y);
      if(!a||!b)continue;const angle=Math.atan2(b.y-a.y,b.x-a.x);const x=(a.x+b.x)/2,y=(a.y+b.y)/2;
      ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.fillStyle='#f4fafc';ctx.beginPath();
      ctx.moveTo(7,0);ctx.lineTo(-4,-4);ctx.lineTo(-4,4);ctx.closePath();ctx.fill();ctx.restore();}
    if(layers.nodes)final.forEach((p,i)=>{const q=pixel(p.x,p.y);if(!q)return;ctx.fillStyle='#fff';ctx.strokeStyle='#c8102e';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(q.x,q.y,5,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.beginPath();ctx.moveTo(q.x,q.y);ctx.lineTo(q.x+Math.cos(p.theta)*14,q.y-Math.sin(p.theta)*14);ctx.stroke();
      ctx.fillStyle=isDark?'#F1F5F9':'#071a2b';ctx.font='10px sans-serif';ctx.fillText(String(i),q.x+7,q.y-7);});
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
    if(goal){const q=pixel(goal.x,goal.y);if(q){ctx.strokeStyle=isDark?'#00B8F0':'#c8102e';ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(q.x,q.y,13,0,Math.PI*2);ctx.stroke();ctx.fillStyle='rgba(0,191,234,.25)';
      ctx.beginPath();ctx.arc(q.x,q.y,8,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.font='bold 11px sans-serif';ctx.fillText('DESTINATION',q.x+18,q.y-12);}}
    visibleDestinations.forEach((destination)=>{
      const q=pixel(destination.x,destination.y);if(!q)return;
      ctx.save();ctx.translate(q.x,q.y);ctx.rotate(Math.PI/4);
      ctx.fillStyle=isDark?'#007BFF':'#1565c0';ctx.strokeStyle='#F1F5F9';ctx.lineWidth=1.5;
      ctx.fillRect(-6,-6,12,12);ctx.strokeRect(-6,-6,12,12);ctx.restore();
      ctx.font='bold 10px sans-serif';
      const textWidth=ctx.measureText(destination.displayName).width;
      ctx.fillStyle=isDark?'rgba(5,13,24,.9)':'rgba(255,255,255,.92)';
      ctx.fillRect(q.x+9,q.y-17,textWidth+8,15);
      ctx.fillStyle=isDark?'#F1F5F9':'#14283b';
      ctx.fillText(destination.displayName,q.x+13,q.y-6);
    });
    if(robotVisualization.status==='visible'&&liveRobotPose){const q=pixel(liveRobotPose.x,liveRobotPose.y);if(q){const warning=robotState?.safetyState?.eStop!=='NONE'||(robotState?.errors?.length??0)>0;
      const color=warning?'#EF4444':robotState?.driving?'#22C55E':isDark?'#007BFF':'#c8102e';ctx.save();ctx.translate(q.x,q.y);ctx.rotate(-liveRobotPose.theta);
      ctx.fillStyle=color;ctx.strokeStyle='#f4fafc';ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(-11,-8,22,16,5);ctx.fill();ctx.stroke();
      ctx.fillStyle='#f4fafc';ctx.beginPath();ctx.moveTo(14,0);ctx.lineTo(6,-5);ctx.lineTo(6,5);ctx.closePath();ctx.fill();ctx.restore();
      ctx.strokeStyle=liveRobotPose.positionInitialized?'rgba(56,217,150,.8)':'rgba(244,185,66,.8)';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(q.x,q.y,18,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#fff';ctx.font='bold 11px sans-serif';ctx.fillText('PHARMAROBOT',q.x+22,q.y-13);}}
    if(startProjection?.projectedPose){
      const q=pixel(startProjection.projectedPose.x,startProjection.projectedPose.y);
      if(q){
        ctx.fillStyle='#7b1fa2';ctx.strokeStyle='#fff';ctx.lineWidth=2;
        ctx.beginPath();ctx.arc(q.x,q.y,7,0,Math.PI*2);ctx.fill();ctx.stroke();
        ctx.fillStyle=isDark?'#F1F5F9':'#071a2b';ctx.font='bold 10px sans-serif';
        ctx.fillText('A* START',q.x+10,q.y-8);
      }
    }
    if(start)drawFootprint(start,'#1565c0');
    ctx.restore();
  },[grid,inflated,start,goal,raw,final,footprint,showInflation,showGrid,rotation,view,isDark,resizeVersion,
    locatorImage,locatorRaster,layers,robotState,generatedOrder,replanOriginal,replanBlocked,
    replanNew,temporaryObstacleCells,inflatedTemporaryObstacleCells,
    replanExplored,startProjection,recoveryPath,plannerDiagnostics,optimizedPath,visibleDestinations,
    baselinePath,rejectedEnhancementPath,liveRobotPose,robotVisualization]);
  const cellFromEvent=(event:React.MouseEvent<HTMLCanvasElement>|React.PointerEvent<HTMLCanvasElement>):GridCell|null=>{
    if(!grid||!canvas.current)return null;const rect=canvas.current.getBoundingClientRect();
    const base=Math.min(rect.width/grid.metadata.width,rect.height/grid.metadata.height)*view.zoom;
    const ox=(rect.width-grid.metadata.width*base)/2+view.panX;const oy=(rect.height-grid.metadata.height*base)/2+view.panY;
    const cx=rect.width/2,cy=rect.height/2;const dx=event.clientX-rect.left-cx,dy=event.clientY-rect.top-cy;
    const c=Math.cos(-rotation),s=Math.sin(-rotation);const sx=c*dx-s*dy+cx,sy=s*dx+c*dy+cy;
    const cell={column:Math.floor((sx-ox)/base),row:Math.floor((sy-oy)/base)};
    return cell.row>=0&&cell.column>=0&&cell.row<grid.metadata.height&&cell.column<grid.metadata.width?cell:null;
  };
  const centerRobot=():void=>{
    const host=container.current;
    if(!grid||!liveRobotPose||!host)return;
    const {width,height}=host.getBoundingClientRect();
    const base=Math.min(width/grid.metadata.width,height/grid.metadata.height)*view.zoom;
    const cell=new CoordinateTransformer(grid.metadata).worldToGrid(liveRobotPose.x,liveRobotPose.y);
    if(!cell)return;
    const dx=(width-grid.metadata.width*base)/2+(cell.column+.5)*base-width/2;
    const dy=(height-grid.metadata.height*base)/2+(cell.row+.5)*base-height/2;
    const cosine=Math.cos(rotation);const sine=Math.sin(rotation);
    setView((current)=>({...current,panX:-cosine*dx-sine*dy,panY:sine*dx-cosine*dy}));
  };
  const toggleFullscreen=():void=>{
    const reportError=(error:unknown):void=>{
      const message=error instanceof Error?error.message:String(error);
      setFullscreenError(`Fullscreen unavailable: ${message}`);
      LogService.write('system','warning',`Map fullscreen request failed: ${message}`);
    };
    try{
      const action=document.fullscreenElement
        ?document.exitFullscreen()
        :container.current?.requestFullscreen();
      if(!action)throw new Error('Fullscreen is not supported by this browser.');
      void action.then(()=>setFullscreenError(undefined)).catch(reportError);
    }catch(error){reportError(error);}
  };
  const layerOptions=[
    {key:'raw',label:'Raw A*',description:'Raw grid-search route before smoothing.',color:'#94A3B8'},
    {key:'baseline',label:'Valid baseline',description:'Collision-checked baseline path.',color:'#22C55E'},
    {key:'rejected',label:'Rejected enhancement',description:'Candidate path rejected by route validation.',color:'#F59E0B'},
    {key:'optimized',label:'Optimized path',description:'Validated optimized route geometry.',color:'#007BFF'},
    {key:'nodes',label:'VDA nodes',description:'Order nodes and their headings.',color:'#F1F5F9'},
    {key:'corridors',label:'Bypass corridors',description:'VDA bypass corridor geometry.',color:'#EF4444'},
    {key:'explored',label:'A* explored cells',description:'Cells explored by global replanning.',color:'#00B8F0'},
    {key:'passages',label:'Doors and alignment',description:'Detected passages and alignment points.',color:'#8B5CF6'},
    {key:'footprints',label:'Bosch footprint at nodes',description:'Robot footprint at each planned node.',color:'#007BFF'},
    {key:'turnSafety',label:'Swept / rejected turns',description:'Footprint sweep and turn-safety rejections.',color:'#EF4444'},
  ] as const;
  const renderLayer=(key:keyof typeof layers,label:string,description:string,color:string)=>
    <Tooltip key={key} title={description} placement="left">
      <FormControlLabel sx={{display:'flex',m:0,minHeight:32,fontSize:12}}
        control={<Switch size="small" checked={layers[key]}
          onChange={(event)=>setLayers((value)=>({...value,[key]:event.target.checked}))}/>}
        label={<Stack direction="row" gap={.7} alignItems="center">
          <Box sx={{width:7,height:7,borderRadius:'50%',bgcolor:color,flexShrink:0}}/>
          <Typography variant="caption">{label}</Typography>
        </Stack>}/>
    </Tooltip>;
  return <Box ref={container} sx={{position:'relative',width:'100%',height:'100%',overflow:'hidden',bgcolor:'var(--mr-bg-primary)'}}>
    <canvas ref={canvas} onClick={(e)=>{
      if(suppressClick.current){suppressClick.current=false;return;}
      const cell=cellFromEvent(e);if(cell)onCell(cell);
    }}
      onPointerDown={(event)=>{
        suppressClick.current=false;
        dragging.current={x:event.clientX,y:event.clientY,panX:view.panX,panY:view.panY};
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={()=>{dragging.current=null;}}
      onPointerCancel={()=>{dragging.current=null;}}
      onPointerMove={(e)=>{
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
        }
      }}
      onWheel={(e)=>{e.preventDefault();setView(v=>({...v,zoom:Math.max(.35,Math.min(8,v.zoom*(e.deltaY<0?1.15:.87)))}));}}
      onContextMenu={(event)=>{event.preventDefault();const cell=cellFromEvent(event);if(cell)setMouse((value)=>({...value,cell}));}}
      style={{display:'block',cursor:'crosshair',touchAction:'none'}}/>
    <Box sx={{position:'absolute',top:12,right:12,display:'flex',gap:.5,zIndex:2}}>
      <Tooltip title="Map layers"><IconButton aria-label="Map layers" onClick={()=>setShowLayers((value)=>!value)}
        sx={{bgcolor:'background.paper','&:hover':{bgcolor:'action.hover'}}}><Layers/></IconButton></Tooltip>
      <Tooltip title="Centre on robot"><span><IconButton aria-label="Centre on robot"
        disabled={!grid||!liveRobotPose} onClick={centerRobot}
        sx={{bgcolor:'background.paper','&:hover':{bgcolor:'action.hover'}}}><CenterFocusStrong/></IconButton></span></Tooltip>
      <Tooltip title="Toggle fullscreen"><IconButton aria-label="Toggle fullscreen" onClick={toggleFullscreen}
        sx={{bgcolor:'background.paper','&:hover':{bgcolor:'action.hover'}}}><Fullscreen/></IconButton></Tooltip>
    </Box>
    {showLayers&&<Paper className="mr-glass" sx={{position:'absolute',top:62,right:12,p:1.25,
      width:230,maxHeight:'calc(100% - 130px)',overflowY:'auto',zIndex:2}}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="overline">Map layers</Typography>
        <Button size="small" onClick={()=>setShowLayers(false)}>Done</Button>
      </Stack>
      <Stack gap={.2}>{layerOptions.slice(0,6).map(({key,label,description,color})=>
        renderLayer(key,label,description,color))}</Stack>
      <Box component="details" sx={{mt:1,borderTop:'1px solid',borderColor:'divider',pt:.7}}>
        <Typography component="summary" variant="caption" sx={{cursor:'pointer',fontWeight:700}}>
          Advanced engineering layers
        </Typography>
        <Stack gap={.2} mt={.5}>{layerOptions.slice(6).map(({key,label,description,color})=>
          renderLayer(key,label,description,color))}</Stack>
      </Box>
    </Paper>}
    {fullscreenError&&<Paper role="status" sx={{position:'absolute',top:62,right:250,p:1,zIndex:3,
      maxWidth:300,bgcolor:'error.dark',color:'common.white'}}>
      <Typography variant="caption">{fullscreenError}</Typography>
    </Paper>}
    <Box sx={{position:'absolute',left:12,bottom:12,display:'flex',gap:1}}>
      <Chip size="small" label={`Mode: ${mode}`} color="primary"/>
      <Chip size="small" label={robotVisualization.label}
        color={robotVisualization.status==='visible'?'success':
          robotVisualization.status==='outside-map'?'warning':'default'}/>
      <Chip size="small" label={mouse.cell?`Grid ${mouse.cell.column}, ${mouse.cell.row}`:'Grid —'}/>
      <Chip size="small" label={mouse.world?`World ${mouse.world.x.toFixed(3)}, ${mouse.world.y.toFixed(3)} m`:'World —'}/>
      {grid&&<Chip size="small" label={`Scale ${(grid.metadata.resolution/view.zoom).toFixed(3)} m/cell`}/>}
    </Box>
    <Box sx={{position:'absolute',right:12,bottom:12,display:'flex',gap:1}}>
      <Tooltip title="Zoom out"><span><IconButton size="small" disabled={view.zoom<=.35}
        onClick={()=>setView((value)=>({...value,zoom:Math.max(.35,value.zoom/1.2)}))}><ZoomOut/></IconButton></span></Tooltip>
      <Chip size="small" label={`${Math.round(view.zoom*100)}%`}/>
      <Tooltip title="Zoom in"><span><IconButton size="small" disabled={view.zoom>=8}
        onClick={()=>setView((value)=>({...value,zoom:Math.min(8,value.zoom*1.2)}))}><ZoomIn/></IconButton></span></Tooltip>
      <Button size="small" onClick={()=>setView({zoom:1,panX:0,panY:0})}>Fit</Button>
    </Box>
  </Box>;
};
