import {useEffect,useRef,useState,type MutableRefObject,type CSSProperties} from 'react';
import {Graph} from '@antv/g6';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import {Scan,ZoomIn,ZoomOut,ChevronLeft,ChevronRight,Pause,Play} from 'lucide-react';
import {type AccumulationData as Data} from './AccumulationScene';
import {kinds} from './accumulation-data.mjs';
import {SourceText} from './SourceText';
import {NodeSprings} from './node-springs';
import {presentation} from './map-presentation';

type Pose={x:number;y:number;alpha:number;scale:number;label:number};
type Camera={x:number;y:number;z:number};
export type MapSceneState={key:string;selected:string|null;camera:Camera;overview:Camera;width:number;height:number;motionPaused:boolean};
export type SceneControls={reset:()=>void};
type Props={data:Data;selected:string|null;emphasis:string|null;reduced:boolean;paused:boolean;onSelect:(id:string|null)=>void;controls:MutableRefObject<SceneControls|null>;sources:Record<string,number>;session:{scene?:MapSceneState}};
const colors:Record<string,string>={sop:'#588f7b',capability:'#a88342',source:'#416baa',task:'#255de1',memory:'#5274c5',experience:'#896e9a',skill:'#58729d',learning:'#318878'};
const evidence=(kind:string)=>['source','learned','produced'].includes(kind);

// Reveal a real edge while retaining its relation-specific dash pattern.
// A long terminal gap clips the unfinished part without inventing a solid edge.
function revealedDash(pattern:number[],length:number,progress:number){
  if(progress>=.999)return pattern;
  let remaining=length*Math.max(0,progress);
  if(!pattern.length)return [remaining,length*2];
  const result:number[]=[];
  while(remaining>0){const ink=Math.min(pattern[0],remaining);result.push(ink);remaining-=ink;const gap=Math.min(pattern[1],remaining);result.push(gap);remaining-=gap;}
  if(!result.length)return [0,length*2];
  result[result.length-1]+=length*2;return result;
}

function membership(data:Data,sources:Record<string,number>){
  const roots=data.nodes.filter(n=>(sources[n.id]||0)>=2).sort((a,b)=>(sources[b.id]||0)-(sources[a.id]||0));
  const dists=roots.map(root=>{const dist=new Map([[root.id,0]]),queue=[root.id];for(let i=0;i<queue.length;i++){const id=queue[i];for(const edge of data.adjacent(id)){const next=edge.source===id?edge.target:edge.source;if(!dist.has(next)){dist.set(next,dist.get(id)!+1);queue.push(next);}}}return dist;});
  return roots.map((root,ri)=>({root,ids:data.nodes.filter(n=>dists[ri].has(n.id)&&dists.reduce((best,d,i)=>(d.get(n.id)??1e6)<(dists[best]?.get(n.id)??1e6)?i:best,0)===ri).map(n=>n.id)}));
}

export function MapScene({data,selected,emphasis,reduced,paused,onSelect,controls,sources,session}:Props){
  const root=useRef<HTMLDivElement>(null),graphHost=useRef<HTMLDivElement>(null),world=useRef<HTMLDivElement>(null);
  const graph=useRef<Graph|null>(null),poses=useRef<Record<string,Pose>>({}),nodes=useRef(new Map<string,HTMLButtonElement>()),faces=useRef(new Map<string,HTMLElement>());
  const camera=useRef<Camera>({x:0,y:0,z:1}),phase=useRef({focus:0,lines:0}),dimensions=useRef({w:1200,h:650});
  const layoutTimeline=useRef<gsap.core.Timeline|null>(null),cameraTween=useRef<gsap.core.Tween|null>(null),hoverTween=useRef<gsap.core.Tween|null>(null);
  const drawRef=useRef<()=>void>(()=>{}),targetRef=useRef<(initial?:boolean)=>void>(()=>{}),releasePointer=useRef<()=>void>(()=>{});
  const cameraDrawRef=useRef<()=>void>(()=>{}),revealRef=useRef<(id:string)=>void>(()=>{}),minimumZoom=useRef(.15);
  const[ready,setReady]=useState(false),[error,setError]=useState(''),[hot,setHot]=useState<string|null>(null),[zoom,setZoom]=useState(100);
  const [neighborPage,setNeighborPage]=useState(0);
  const [motionPaused,setMotionPaused]=useState(session.scene?.motionPaused||false);
  const motionPausedRef=useRef(motionPaused);motionPausedRef.current=motionPaused;
  const allNeighbors=selected?[...data.neighbourIds(selected)].filter(id=>id!==selected):[];
  const page=Math.min(neighborPage,Math.max(0,Math.ceil(allNeighbors.length/6)-1));
  const shownNeighbors=allNeighbors.slice(page*6,page*6+6);
  const settings=useRef({selected,emphasis,reduced,paused:paused||motionPaused,hot,shownNeighbors});settings.current={selected,emphasis,reduced,paused:paused||motionPaused,hot,shownNeighbors};
  useEffect(()=>setNeighborPage(0),[selected,data]);
  const cohorts=useRef(membership(data,sources));
  const groupIndex=useRef(new Map<string,number>());
  const groupFor=(id:string)=>groupIndex.current.get(id)??-1;

  useGSAP(()=>{
    const host=root.current!;setReady(false);host.dataset.ready='false';setError('');cohorts.current=membership(data,sources);let disposed=false,drawing=false,pending=false,inView=true,ro:ResizeObserver|undefined,visibility:IntersectionObserver|undefined;
    const signal=new AbortController();
    groupIndex.current=new Map(cohorts.current.flatMap((g,i)=>g.ids.map(id=>[id,i] as const)));
    const positions:Record<string,Pose>=poses.current={};
    let anchors:Record<string,{x:number;y:number}>={};
    let overviewCamera:Camera={x:0,y:0,z:1},previousSelection:string|null=null;
    const stateKey=JSON.stringify([data.nodes.map(n=>n.id),data.edges.map(e=>[e.id,e.source,e.target])]);
    const labelSizes=new Map<string,{w:number;h:number}>();
    const nodePaint=new Map<string,string>(),facePaint=new Map<string,string>(),graphPaint=new Map<string,string>();
    // G6 still owns the shapes and edge geometry. Updating its rendered shapes
    // avoids rerunning the data/layout pipeline for transient spring offsets.
    type RenderShape={update:(style:Record<string,unknown>)=>void;attr:(style:Record<string,unknown>)=>void;getShape:(name:string)=>{attr:(style:Record<string,unknown>)=>void}};
    const shapes=new Map<string,RenderShape>(),arrowPaint=new Map<string,boolean>();
    let edgePaint='',cameraPaint='',labelTime=0,labelTimer:ReturnType<typeof setTimeout>|undefined;
    const ranked=[...data.nodes].sort((a,b)=>(sources[b.id]||0)-(sources[a.id]||0)||data.adjacent(b.id).length-data.adjacent(a.id).length||a.id.localeCompare(b.id));
    const edgesByNode=new Map(data.nodes.map(n=>[n.id,data.adjacent(n.id)]));
    const edgeReveal=Object.fromEntries(data.edges.map(e=>[e.id,{p:settings.current.reduced?1:0}]));
    const springs=new NodeSprings(data.nodes.map(n=>n.id),data.edges,cohorts.current.map(g=>({root:g.root.id,ids:g.ids}))),pointer={x:0,y:0,active:false};
    let springAwake=false,springElapsed=0,heldNode:string|null=null;
    const visualPosition=(id:string)=>{const p=positions[id],s=springs.offsets[id];return {x:p.x+s.x,y:p.y+s.y};};
    function sleepSprings(){gsap.ticker.remove(springTick);springAwake=false;host.dataset.springActive='false';}
    function springTick(_time:number,deltaMs:number){
      if(disposed||document.hidden||!inView){sleepSprings();return;}
      if(settings.current.reduced){springs.reset();sleepSprings();draw();return;}
      if(settings.current.paused){sleepSprings();return;}
      // Hold the current offsets during camera navigation. They resume from
      // the same phase afterwards, without a jump or geometry work while panning.
      if(drag||cameraTween.current?.isActive()){springElapsed=0;return;}
      springElapsed+=deltaMs;
      // Ordinary maps use the preview's GSAP frame clock without the old
      // 24Hz idle gate. Only large overviews retain a bounded draw budget.
      if(data.nodes.length>80&&springElapsed<1000/(pointer.active?60:30)-1)return;
      const moving=springs.step(springElapsed/1000,positions,pointer,camera.current.z,settings.current.selected,heldNode);springElapsed=0;
      draw();if(!moving)sleepSprings();
    }
    function wakeSprings(){
      if(springAwake||disposed||!readyLocal||settings.current.reduced||settings.current.paused||document.hidden||!inView||host.dataset.animating==='true')return;
      springAwake=true;springElapsed=0;host.dataset.springActive='true';gsap.ticker.add(springTick);
    }
    releasePointer.current=()=>{pointer.active=false;wakeSprings();};
    let lastSize='',readyLocal=false,drag:{x:number;y:number;cx:number;cy:number;pointer:number}|null=null;
    const currentOverview=()=>{
      const {w,h}=dimensions.current,values=Object.values(anchors);
      const xs=values.map(p=>p.x),ys=values.map(p=>p.y);
      const minX=values.length?Math.min(...xs):0,minY=values.length?Math.min(...ys):0;
      const spanX=values.length?Math.max(...xs)-minX:1,spanY=values.length?Math.max(...ys)-minY:1;
      const sx=Math.max(1,(w-180)/Math.max(1,spanX)),sy=Math.max(1,(h-190)/Math.max(1,spanY));
      return Object.fromEntries(data.nodes.map((n,i)=>{const seed=n as typeof n&{x?:number;y?:number};const p=anchors[n.id];
        return[n.id,{x:p?w/2+(p.x-minX-spanX/2)*sx:(seed.x??Math.cos(i*2.4)*Math.sqrt(i)*80),
          y:p?(h-40)/2+(p.y-minY-spanY/2)*sy:(seed.y??Math.sin(i*2.4)*Math.sqrt(i)*80),alpha:1,scale:1,label:1}];}));
    };
    function fitCamera():Camera{
      const points=Object.values(currentOverview()),{w,h}=dimensions.current;
      const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y));
      const z=Math.min(1,(w-150)/(maxX-minX+90),(h-140)/(maxY-minY+90));
      minimumZoom.current=Math.max(.04,z*.65);
      return {x:w/2-(minX+maxX)/2*z,y:(h-35)/2-(minY+maxY)/2*z,z};
    }
    async function sizeGraph(){
      const g=graph.current;if(!g||g.destroyed)return;
      const points=Object.values(currentOverview()),{w,h}=dimensions.current,padding=240;
      const left=Math.floor(Math.min(0,...points.map(p=>p.x))-padding),top=Math.floor(Math.min(0,...points.map(p=>p.y))-padding);
      const width=Math.ceil(Math.max(w,...points.map(p=>p.x))+padding-left),height=Math.ceil(Math.max(h,...points.map(p=>p.y))+padding-top);
      Object.assign(graphHost.current!.style,{left:`${left}px`,top:`${top}px`,width:`${width}px`,height:`${height}px`,right:'auto',bottom:'auto'});
      g.setSize(width,height);await g.translateTo([-left,-top],false);
    }
    // Labels keep a readable screen size. Occupancy is computed from cached
    // font measurements, never by measuring every element on every frame.
    function placeLabels(force=false){
      if(disposed)return;
      const now=performance.now();if(!force&&now-labelTime<90){if(!labelTimer)labelTimer=setTimeout(()=>{labelTimer=undefined;placeLabels(true);},95);return;}labelTime=now;
      const c=camera.current,{w,h}=dimensions.current,{selected:id,hot:hover}=settings.current;
      type Box={left:number;right:number;top:number;bottom:number;id:string};
      const grid=new Map<string,Box[]>(),keys=(b:Box)=>{const result=[];for(let x=Math.floor(b.left/100);x<=Math.floor(b.right/100);x++)for(let y=Math.floor(b.top/60);y<=Math.floor(b.bottom/60);y++)result.push(`${x}:${y}`);return result;};
      const insert=(b:Box)=>{for(const key of keys(b)){const list=grid.get(key)||[];list.push(b);grid.set(key,list);}};
      const hit=(b:Box)=>keys(b).some(key=>(grid.get(key)||[]).some(a=>a.id!==b.id&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top));
      for(const n of data.nodes){const p=positions[n.id];if(!p||p.alpha<.3)continue;const r=(sources[n.id]>=2?37:28)*p.scale*c.z+4,x=p.x*c.z+c.x,y=p.y*c.z+c.y;insert({left:x-r,right:x+r,top:y-r,bottom:y+r,id:n.id});}
      const order=[...ranked].sort((a,b)=>Number(b.id===hover||b.id===id)-Number(a.id===hover||a.id===id));
      let visible=0;
      for(const n of order){const p=positions[n.id],el=nodes.current.get(n.id),size=labelSizes.get(n.id);if(!p||!el||!size)continue;
        const x=p.x*c.z+c.x,y=p.y*c.z+c.y+((sources[n.id]>=2?37:28)+12)*p.scale*c.z;
        const radius=(sources[n.id]>=2?37:28)*p.scale*c.z;
        const candidates=[[0,0],[0,-2*radius-12*p.scale*c.z-size.h-6],[size.w/2+radius+10,-radius-12*p.scale*c.z-size.h/2],[-size.w/2-radius-10,-radius-12*p.scale*c.z-size.h/2]];
        const active=n.id===hover||n.id===id,near=!id||n.id===id||settings.current.shownNeighbors.includes(n.id);
        const choices=candidates.map(([dx,dy])=>({dx,dy,box:{left:x+dx-size.w/2-5,right:x+dx+size.w/2+5,top:y+dy-3,bottom:y+dy+size.h+3,id:n.id}}));
        const inside=(b:Box)=>b.left>5&&b.right<w-5&&b.top>5&&b.bottom<h-5;
        const choice=choices.find(v=>inside(v.box)&&!hit(v.box))||(active?choices.find(v=>inside(v.box)):undefined);
        const overviewHub=!id&&c.z<.45&&cohorts.current.length>0;
        const fallback=sources[n.id]>=2?choices.find(v=>inside(v.box)):undefined;
        const placement=choice||fallback;
        const show=near&&p.alpha>.3&&!!placement&&(!overviewHub||sources[n.id]>=2||active);
        const value=String(show);if(el.dataset.labelVisible!==value)el.dataset.labelVisible=value;
        if(show&&placement){visible++;insert(placement.box);el.style.setProperty('--label-x',`${placement.dx}px`);el.style.setProperty('--label-y',`${placement.dy}px`);}
      }
      host.dataset.visibleLabels=String(visible);
    }
    function drawCamera(){
      if(disposed||!world.current)return;const c=camera.current;
      const key=`${c.x}:${c.y}:${c.z}`;if(cameraPaint===key)return;cameraPaint=key;
      world.current.style.transform=`translate(${c.x}px,${c.y}px) scale(${c.z})`;
      world.current.style.setProperty('--camera-inverse',String(1/c.z));placeLabels();
      host.dataset.zoom=String(c.z);
    }
    cameraDrawRef.current=drawCamera;
    revealRef.current=(id:string)=>{
      const p=positions[id];if(!p||settings.current.selected)return;
      const c=camera.current,{w,h}=dimensions.current,x=p.x*c.z+c.x,y=p.y*c.z+c.y;
      if(x>100&&x<w-100&&y>80&&y<h-100){placeLabels(true);return;}
      cameraTween.current?.kill();cameraTween.current=gsap.to(c,{x:w/2-p.x*c.z,y:h/2-p.y*c.z,duration:settings.current.reduced?0:.3,ease:'power2.out',onUpdate:drawCamera});
    };
    function targets(){
      const map=currentOverview(),{selected:id}=settings.current,{w,h}=dimensions.current;
      if(!id||!data.byId[id]){const kind=settings.current.emphasis;if(kind)for(const n of data.nodes)map[n.id].alpha=n.kind===kind?1:.2;return map;}
      const near=settings.current.shownNeighbors,cw=w-(w<1100?305:350)-35;
      for(const n of data.nodes){map[n.id].x=45+(map[n.id].x-45)*.70;map[n.id].alpha=data.nodes.length>80?.045:.13;map[n.id].scale=.88;}
      map[id]={x:cw*.52,y:h*.42,alpha:1,scale:sources[id]>=2?1.12:1.32,label:1};
      const slots=near.length===1?[[.23,.42]]:near.length===2?[[.20,.24],[.81,.64]]:near.length===3?[[.20,.21],[.83,.40],[.47,.80]]:[[.18,.20],[.81,.20],[.83,.65],[.27,.79],[.50,.10],[.51,.87]];
      near.forEach((n,i)=>{const xy=slots[i%slots.length];map[n]={x:Math.max(88,Math.min(cw-70,cw*xy[0])),y:65+(h-170)*xy[1],alpha:1,scale:sources[n]>=2?.78:1,label:1};});
      return map;
    }
    function edgeStyle(e:any){
      const {selected:id,hot:hover}=settings.current,active=hover||id;
      const visible=(key:string)=>key===id||settings.current.shownNeighbors.includes(key);
      const direct=!!active&&(e.source===active||e.target===active)&&(!id||(visible(e.source)&&visible(e.target))),muted=!!active&&!direct;
      const formed=evidence(e.kind),used=e.kind==='used',bridge=groupFor(e.source)!==groupFor(e.target);
      const p=edgeReveal[e.id].p,a=visualPosition(e.source),b=visualPosition(e.target),radius=(key:string)=>(sources[key]>=2?37:28)*positions[key].scale;
      const length=Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)-radius(e.source)-radius(e.target));
      const pattern=formed?[]:used?[7,5]:bridge?[4,4]:[3,6];
      return {stroke:bridge?'#6583b3':used?'#527dd5':formed?'#5b91a1':'#91a2b8',opacity:phase.current.lines*(muted?(id?.045:.25):direct?.94:bridge?.82:formed?.62:used?.44:.34),lineWidth:(direct?2.3:bridge?1.9:formed?1.65:1.25)/Math.max(.5,id?1:overviewCamera.z),lineDash:revealedDash(pattern,length,p),endArrow:!!id&&direct&&formed,endArrowSize:5};
    }
    async function drawGraph(){
      const g=graph.current;if(disposed||!g||g.destroyed)return;
      if(drawing){pending=true;return;}drawing=true;
      try{
        const changed=data.nodes.flatMap(n=>{const p=visualPosition(n.id),size=(sources[n.id]>=2?74:56)*positions[n.id].scale;
          const quantum=.2/camera.current.z;
          const key=`${Math.round(p.x/quantum)}:${Math.round(p.y/quantum)}:${size.toFixed(2)}`;if(graphPaint.get(n.id)===key)return [];graphPaint.set(n.id,key);return [{id:n.id,style:{...p,size}}];});
        const {selected:id,hot:hover,emphasis:kind,shownNeighbors:near}=settings.current;
        const key=`${id}:${hover}:${kind}:${near.join(',')}:${phase.current.lines.toFixed(3)}:${host.dataset.animating}`;
        const allEdges=key!==edgePaint||host.dataset.animating==='true';edgePaint=key;
        const affected=allEdges?data.edges:[...new Set(changed.flatMap(n=>edgesByNode.get(n.id)||[]))];
        if(!changed.length&&!affected.length)return;
        if(shapes.size===data.nodes.length+data.edges.length){
          // DOM owns the visible symbols. The G6 node shapes are transparent
          // layout anchors; only their line endpoints need transient updates.
          // Mutate the G6 Path, retaining its arrows/dashes/renderer, rather
          // than rebuilding ports, labels, halos and badges on every tick.
          for(const e of affected){
            const shape=shapes.get(e.id)!,a=visualPosition(e.source),b=visualPosition(e.target),distance=Math.max(1,Math.hypot(b.x-a.x,b.y-a.y));
            const radius=(id:string)=>(sources[id]>=2?37:28)*positions[id].scale;
            const ra=Math.min(.48,radius(e.source)/distance),rb=Math.min(.48,radius(e.target)/distance);
            if(allEdges){const style=edgeStyle(e);if(arrowPaint.get(e.id)!==style.endArrow){shape.update(style);shape.attr({opacity:1});arrowPaint.set(e.id,style.endArrow);}shape.getShape('key').attr({stroke:style.stroke,opacity:style.opacity,lineWidth:style.lineWidth,lineDash:style.lineDash});}
            shape.getShape('key').attr({d:[['M',a.x+(b.x-a.x)*ra,a.y+(b.y-a.y)*ra],['L',b.x+(a.x-b.x)*rb,b.y+(a.y-b.y)*rb]]});
          }
        }else{
          if(changed.length)g.updateNodeData(changed);
          if(affected.length)g.updateEdgeData(affected.map(e=>({id:e.id,style:edgeStyle(e)})));
          await g.draw();
        }
      }
      catch{if(!disposed)setError('连线暂未显示，仍可点开节点查看关联。');}
      finally{drawing=false;if(pending&&!disposed){pending=false;void drawGraph();}}
    }
    function draw(){
      if(disposed)return;
      let poseChanged=false;
      for(const node of data.nodes){const p=positions[node.id],s=springs.offsets[node.id],el=nodes.current.get(node.id),face=faces.current.get(node.id);if(!p||!el)continue;
        const key=`${p.x}:${p.y}:${p.alpha}:${p.label}:${p.scale}`;
        if(nodePaint.get(node.id)!==key){poseChanged=true;el.style.transform=`translate(${p.x}px,${p.y}px)`;el.style.opacity=String(p.alpha);el.style.setProperty('--label-reveal',String(p.label));el.style.setProperty('--pose-inverse',String(1/p.scale));nodePaint.set(node.id,key);}
        const quantum=.2/camera.current.z,sx=Math.round(s.x/quantum)*quantum,sy=Math.round(s.y/quantum)*quantum,faceKey=`${sx}:${sy}:${p.scale}`;
        if(face&&facePaint.get(node.id)!==faceKey){face.style.transform=`translate(${sx}px,${sy}px) translateX(-50%) scale(${p.scale})`;face.style.willChange=sx||sy?'transform':'auto';facePaint.set(node.id,faceKey);}
      }
      drawCamera();
      if(poseChanged)placeLabels();
      if(readyLocal)void drawGraph();
    }
    drawRef.current=draw;
    function focus(initial=false,refit=false){
      if(disposed||!readyLocal)return;
      layoutTimeline.current?.kill();hoverTween.current?.kill();cameraTween.current?.kill();
      // Capture the rendered position before a layout move. Selection must not
      // first snap a displaced face back to its anchor.
      pointer.active=false;sleepSprings();
      for(const node of data.nodes){const p=positions[node.id],s=springs.offsets[node.id];if(p){p.x+=s.x;p.y+=s.y;}}
      springs.reset();
      const map=targets(),id=settings.current.selected,saved=initial?session.scene:undefined;
      const restore=saved?.key===stateKey&&saved.selected===id&&saved.width===dimensions.current.w&&saved.height===dimensions.current.h?saved:undefined;
      const quiet=settings.current.reduced||settings.current.paused||!!restore;
      const neighbors=settings.current.shownNeighbors;
      if(initial){overviewCamera=fitCamera();if(restore)overviewCamera={...restore.overview};}else if(!refit&&!previousSelection)overviewCamera={...camera.current};
      const destination=restore?restore.camera:id?{x:0,y:0,z:1}:overviewCamera;previousSelection=id;
      const tl=gsap.timeline({onUpdate:draw,onComplete:()=>{host.dataset.animating='false';springs.setBounds(positions,Object.fromEntries(data.nodes.map(n=>[n.id,(sources[n.id]>=2?37:28)*positions[n.id].scale])));draw();placeLabels(true);wakeSprings();}});layoutTimeline.current=tl;host.dataset.animating=quiet?'false':'true';
      tl.to(camera.current,{...destination,duration:quiet?0:.6,ease:'power3.inOut'},0);
      tl.to(phase.current,{focus:id?1:0,lines:1,duration:quiet?0:initial?.9:.62,ease:'power2.inOut'},0);
      for(const [i,node]of data.nodes.entries()){
        const target=map[node.id],p=positions[node.id],near=neighbors.indexOf(node.id);
        const delay=quiet?0:initial?(sources[node.id]>=2?0:.12+Math.max(0,groupFor(node.id))*.04+Math.min(i*.024,.45)):id&&near>=0?.055+near*.032:0;
        tl.to(p,{x:target.x,y:target.y,alpha:target.alpha,scale:target.scale,duration:quiet?0:initial?1.04:.78,ease:initial?'back.out(1.12)':'power3.inOut'},delay);
        tl.to(p,{label:1,duration:quiet?0:.38,ease:'power2.out'},initial&&!quiet?delay+.20:0);
      }
      for(const [i,edge]of data.edges.entries())tl.to(edgeReveal[edge.id],{p:1,duration:quiet?0:initial?.72:.3,ease:'power2.out'},initial&&!quiet?.20+Math.min(i*.025,.45):0);
      setZoom(Math.round(destination.z*100));
    }
    targetRef.current=focus;
    function resize(){
      const w=host.clientWidth,h=host.clientHeight;if(!w||!h||`${w}:${h}`===lastSize)return;lastSize=`${w}:${h}`;dimensions.current={w,h};
      if(graph.current&&!graph.current.destroyed)void sizeGraph();
      if(readyLocal){overviewCamera=fitCamera();focus(false,true);}
    }
    async function start(){
      await document.fonts.ready;if(disposed)return;resize();
      for(const n of data.nodes){const label=nodes.current.get(n.id)?.querySelector<HTMLElement>('.rm-node-label');if(label)labelSizes.set(n.id,{w:label.offsetWidth,h:label.offsetHeight});}
      if(!host.clientWidth||!host.clientHeight){setError('地图空间不足，请放大窗口后重新打开。');return;}
      const map=currentOverview();data.nodes.forEach(n=>{const p=map[n.id],r=cohorts.current[groupFor(n.id)]?.root.id,anchor=r?map[r]:p;positions[n.id]={...p,x:settings.current.reduced?p.x:anchor.x+(p.x-anchor.x)*.58,y:settings.current.reduced?p.y:anchor.y+(p.y-anchor.y)*.58,alpha:settings.current.reduced?1:0,scale:settings.current.reduced?1:.7,label:settings.current.reduced?1:0};});
      draw();
      const {w,h}=dimensions.current;
      try{const g=new Graph({container:graphHost.current!,width:w,height:h,devicePixelRatio:data.nodes.length>80?1:Math.min(2,window.devicePixelRatio),animation:false,autoResize:false,
        layout:{type:'d3-force',preLayout:true,animation:false,iterations:240,center:false,
          manyBody:{strength:-460,distanceMax:1300},link:{distance:185,strength:.6},collide:{radius:65,strength:1,iterations:3},
          x:{x:0,strength:.001},y:{y:0,strength:.07},alphaDecay:.035,velocityDecay:.5},
        data:{nodes:data.nodes.map(n=>({id:n.id,style:{x:positions[n.id].x,y:positions[n.id].y,size:sources[n.id]>=2?74:56}})),edges:data.edges.map(e=>({...e,style:edgeStyle(e)}))},
        node:{type:'circle',style:{fill:'transparent',stroke:'transparent',pointerEvents:'none'}},
        edge:{type:'line',style:{stroke:(e:any)=>e.style.stroke,lineWidth:(e:any)=>e.style.lineWidth,opacity:(e:any)=>e.style.opacity,lineDash:(e:any)=>e.style.lineDash,endArrow:(e:any)=>e.style.endArrow,endArrowSize:5}},behaviors:[]});
      graph.current=g;
      await g.render();if(disposed)return;
      const renderRoot=g.getCanvas().getRoot();
      for(const item of [...data.nodes,...data.edges]){const shape=renderRoot.getElementById(item.id) as unknown as RenderShape|null;if(shape&&typeof shape.update==='function'&&typeof shape.getShape==='function')shapes.set(item.id,shape);}
      anchors=Object.fromEntries(g.getNodeData().map(n=>[n.id,{x:Number(n.style!.x),y:Number(n.style!.y)}]));
      await sizeGraph();if(disposed)return;
      const overview=currentOverview();
      for(const n of data.nodes){const p=overview[n.id],group=cohorts.current[groupFor(n.id)],anchor=group?overview[group.root.id]:p;
        positions[n.id]={...p,x:anchor.x+(p.x-anchor.x)*.58,y:anchor.y+(p.y-anchor.y)*.58,alpha:0,scale:.7,label:0};}
      readyLocal=true;setReady(true);host.dataset.ready='true';focus(true);}
      catch{if(disposed)return;setError('连线暂未显示，仍可点开节点查看关联。');
        const failed=graph.current;graph.current=null;if(failed&&!failed.destroyed)failed.destroy();
        anchors=Object.fromEntries(data.nodes.map(n=>[n.id,{x:positions[n.id].x,y:positions[n.id].y}]));
        readyLocal=true;setReady(true);host.dataset.ready='true';focus(true);}
      ro=new ResizeObserver(resize);ro.observe(host);
      visibility=new IntersectionObserver(([entry])=>{inView=entry.isIntersecting;if(inView)wakeSprings();else{pointer.active=false;sleepSprings();}},{threshold:0});visibility.observe(host);
      host.addEventListener('wheel',event=>{if((event.target as Element).closest('button,aside'))return;event.preventDefault();releasePointer.current();const c=camera.current,rect=host.getBoundingClientRect(),z=Math.max(minimumZoom.current,Math.min(2.2,c.z*Math.exp(-event.deltaY*.001)));const x=event.clientX-rect.left,y=event.clientY-rect.top,ratio=z/c.z;cameraTween.current?.kill();cameraTween.current=gsap.to(c,{x:x-(x-c.x)*ratio,y:y-(y-c.y)*ratio,z,duration:settings.current.reduced?0:.18,ease:'power2.out',onUpdate:drawCamera});setZoom(Math.round(z*100));},{passive:false,signal:signal.signal});
      host.addEventListener('pointerdown',e=>{releasePointer.current();if(e.button!==0)return;const node=(e.target as Element).closest<HTMLElement>('.rm-node');if(node){heldNode=node.dataset.nodeId||null;return;}if((e.target as Element).closest('button'))return;cameraTween.current?.kill();const c=camera.current;drag={x:e.clientX,y:e.clientY,cx:c.x,cy:c.y,pointer:e.pointerId};host.setPointerCapture(e.pointerId);host.classList.add('is-dragging');},{signal:signal.signal});
      host.addEventListener('pointermove',e=>{
        if(drag){camera.current.x=drag.cx+e.clientX-drag.x;camera.current.y=drag.cy+e.clientY-drag.y;drawCamera();return;}
        if(e.pointerType==='touch'||(e.target as Element).closest('.rm-zoom')||host.dataset.animating==='true'){releasePointer.current();return;}
        const rect=host.getBoundingClientRect(),c=camera.current;
        pointer.x=(e.clientX-rect.left-c.x)/c.z;pointer.y=(e.clientY-rect.top-c.y)/c.z;pointer.active=true;wakeSprings();
      },{signal:signal.signal});
      host.addEventListener('pointerleave',()=>releasePointer.current(),{signal:signal.signal});
      const release=()=>{heldNode=null;drag=null;host.classList.remove('is-dragging');wakeSprings();};window.addEventListener('pointerup',release,{signal:signal.signal});window.addEventListener('pointercancel',release,{signal:signal.signal});window.addEventListener('blur',release,{signal:signal.signal});
      document.addEventListener('visibilitychange',()=>{if(document.hidden||settings.current.paused){heldNode=null;layoutTimeline.current?.pause();cameraTween.current?.pause();pointer.active=false;sleepSprings();}else{layoutTimeline.current?.resume();cameraTween.current?.resume();wakeSprings();}},{signal:signal.signal});
      controls.current={reset:()=>{cameraTween.current?.kill();cameraTween.current=gsap.to(camera.current,{...(settings.current.selected?{x:0,y:0,z:1}:fitCamera()),duration:settings.current.reduced?0:.5,ease:'power3.inOut',onUpdate:drawCamera});setZoom(Math.round((settings.current.selected?1:fitCamera().z)*100));}};
    }
    void start();
    return()=>{if(readyLocal)session.scene={key:stateKey,selected:settings.current.selected,camera:{...camera.current},overview:{...overviewCamera},width:dimensions.current.w,height:dimensions.current.h,motionPaused:motionPausedRef.current};disposed=true;clearTimeout(labelTimer);sleepSprings();ro?.disconnect();visibility?.disconnect();signal.abort();layoutTimeline.current?.kill();cameraTween.current?.kill();hoverTween.current?.kill();controls.current=null;const g=graph.current;if(g&&!g.destroyed)g.destroy();graph.current=null;drawRef.current=()=>{};cameraDrawRef.current=()=>{};revealRef.current=()=>{};targetRef.current=()=>{};releasePointer.current=()=>{};};
  },{scope:root,dependencies:[data],revertOnUpdate:true});

  useEffect(()=>{if(ready)targetRef.current();},[selected,reduced,paused,emphasis,page]);
  useEffect(()=>{if(ready&&!motionPaused)releasePointer.current();},[motionPaused,ready]);
  useEffect(()=>{
    if(!ready||root.current?.dataset.animating==='true')return;
    const id=hot||selected,near=id?data.neighbourIds(id):null;
    hoverTween.current?.kill();
    const values=data.nodes.map(n=>poses.current[n.id]).filter(Boolean);
    hoverTween.current=gsap.to(values,{alpha:(i:number)=>near?(near.has(data.nodes[i].id)?1:selected?(data.nodes.length>80?.045:.13):.58):emphasis?(data.nodes[i].kind===emphasis?1:.2):1,duration:reduced?0:.2,ease:'power2.out',onUpdate:()=>drawRef.current()});
  },[hot,selected,emphasis,ready,reduced,data]);
  const zoomBy=(factor:number)=>{releasePointer.current();const c=camera.current,{w,h}=dimensions.current,z=Math.max(minimumZoom.current,Math.min(2.2,c.z*factor)),cx=(w-(selected?350:0))/2,cy=h/2,ratio=z/c.z;cameraTween.current?.kill();cameraTween.current=gsap.to(c,{x:cx-(cx-c.x)*ratio,y:cy-(cy-c.y)*ratio,z,duration:reduced?0:.3,ease:'power2.out',onUpdate:()=>cameraDrawRef.current()});setZoom(Math.round(z*100));};

  return <div ref={root} className="rm-scene" data-ready={ready} data-selected={selected||''}>
    <div ref={world} className="rm-world"><div ref={graphHost} className="rm-graph" aria-hidden="true"/>
      <div className="rm-nodes" aria-label="积累与记录">{data.nodes.map(node=>{const view=presentation(node,data.nodes),Icon=view.icon,hub=sources[node.id]>=2,isSelected=node.id===selected;return <button className={'rm-node '+node.kind+(hub?' is-hub':'')+(isSelected?' is-selected':'')} key={node.id} data-node-id={node.id} data-muted={!!selected&&node.id!==selected&&!shownNeighbors.includes(node.id)} title={node.title} style={{'--node-color':colors[node.kind]||'#5379aa'} as CSSProperties} ref={el=>{if(el)nodes.current.set(node.id,el);else nodes.current.delete(node.id);}} aria-label={`${kinds[node.kind].label}：${node.title}`} aria-pressed={isSelected} onClick={()=>onSelect(node.id)} onPointerEnter={()=>setHot(node.id)} onPointerLeave={()=>setHot(null)} onFocus={()=>{setHot(node.id);revealRef.current(node.id);}} onBlur={()=>setHot(null)}>
        <span className="rm-node-inner" ref={el=>{if(el)faces.current.set(node.id,el);else faces.current.delete(node.id);}}><span className="rm-node-symbol"><Icon size={hub?32:26} strokeWidth={1.6} aria-hidden="true"/></span><span className="rm-node-label"><strong><SourceText>{view.label}</SourceText></strong></span></span>
      </button>;})}</div>
    </div>
    {selected&&allNeighbors.length>6&&<div className="rm-neighbors" aria-label="直接关联分页"><button aria-label="上一组关联" disabled={page===0} onClick={()=>setNeighborPage(page-1)}><ChevronLeft size={17}/></button><span>{page*6+1}–{Math.min((page+1)*6,allNeighbors.length)} / {allNeighbors.length}</span><button aria-label="下一组关联" disabled={(page+1)*6>=allNeighbors.length} onClick={()=>setNeighborPage(page+1)}><ChevronRight size={17}/></button></div>}
    {!ready&&<p className="rm-loading" role="status">正在展开积累地图…</p>}{error&&<p className="rm-error" role="status">{error}</p>}
    <div className="rm-zoom"><button aria-label={reduced?'系统已减少动态':paused?'动效已暂停':motionPaused?'继续地图动效':'暂停地图动效'} title={reduced?'系统已减少动态':paused?'动效已暂停':motionPaused?'继续地图动效':'暂停地图动效'} disabled={reduced||paused} onClick={()=>setMotionPaused(v=>!v)}>{motionPaused||paused||reduced?<Play size={16}/>:<Pause size={16}/>}</button><i/><button aria-label="缩小地图" onClick={()=>zoomBy(1/1.15)}><ZoomOut size={17}/></button><span>{zoom}%</span><button aria-label="放大地图" onClick={()=>zoomBy(1.15)}><ZoomIn size={17}/></button><i/><button aria-label="查看全图" onClick={()=>controls.current?.reset()}><Scan size={17}/></button></div>
  </div>;
}
