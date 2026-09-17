import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {Graph} from '@antv/g6';
import gsap from 'gsap';
import {useGSAP} from '@gsap/react';
import {Popover} from 'radix-ui';
import {Brain,ListChecks,WandSparkles,Lightbulb,Sprout,Puzzle,BriefcaseBusiness,Files,Pause,Play,ZoomIn,ZoomOut,Scan,ArrowUpRight,ChevronLeft,ChevronRight,Info,GitBranch} from 'lucide-react';
import {kinds} from './accumulation-data.mjs';
import {collectionDescriptions,networkEdge} from './accumulation-network.mjs';
import {localizeText} from '../lib/i18n';
import {SourceText} from './SourceText';

export const accumulationIcons:Record<string,typeof Brain> = {memory:Brain,sop:ListChecks,capability:WandSparkles,experience:Lightbulb,learning:Sprout,skill:Puzzle,task:BriefcaseBusiness,source:Files};
export type AccumulationNode = {id:string;title:string;summary:string;kind:string;area?:string;assetId?:string;entry?:any};
export type AccumulationData = {nodes:AccumulationNode[];edges:any[];byId:Record<string,AccumulationNode>;skipped:number;partial:boolean;adjacent:(id:string)=>any[];neighbourIds:(id:string)=>Set<string>};
type Point = [number,number];
type Props = {data:AccumulationData;model:any;selected:string|null;returnKey:number;onSelect:(id:string)=>void;onGroup:(kind:string)=>void;reduced:boolean;paused:boolean;onPause:()=>void;onPage:(page:number)=>void};
const tones:Record<string,string> = {formed:'#408978',used:'#497cb8',related:'#9daeb9'};
const dashes:Record<string,number[]> = {formed:[],used:[7,5],related:[3,6]};

export function AccumulationScene({data,model,selected,returnKey,onSelect,onGroup,reduced,paused,onPause,onPage}:Props) {
  const root=useRef<HTMLDivElement>(null),canvas=useRef<HTMLDivElement>(null),layer=useRef<HTMLDivElement>(null);
  const zoomLabel=useRef<HTMLSpanElement>(null);
  const scene=useRef<{zoom:(factor:number)=>Promise<void>;reset:(animate?:boolean,delay?:number)=>Promise<void>;focus:(id:string,delay?:number)=>void;cancelFocus:()=>void;finishFocus:()=>void}|null>(null);
  const hadSelection=useRef(false),lastReturn=useRef(returnKey),lastModel=useRef(model);
  const tween=useRef<gsap.core.Tween|null>(null),previous=useRef(new Map<string,Point>());
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[hot,setHot]=useState<string|null>(null);
  const prefs=useRef({reduced,paused,selected,hot}); prefs.current={reduced,paused,selected,hot};

  useEffect(()=>{
    const host=root.current!,overlay=layer.current!,abort=new AbortController();
    let disposed=false,g:Graph|undefined,resize:ResizeObserver|undefined,waitSize:ResizeObserver|undefined,intersection:IntersectionObserver|undefined;
    let inView=true,drawing=false,clock=0,last=0,lastDrift=0,lastKey='',labelKey='',hoverClock=0,lastActive:string|null=null,entranceDone=false,failed=false;
    let viewportDirty=true,externalMoving=false,lastLabelTime=0,lastLabelActive:string|null=null;
    let pointer:Point|null=null,anchors=new Map<string,Point>(),positions=new Map<string,Point>(),lastSize='';
    let focusTween:gsap.core.Tween|null=null;
    let focusMotion:{id?:string;point:Point;progress:number;fromZoom:number;toZoom:number;from:Point;to:Point}|null=null;
    const dom=new Map<string,HTMLButtonElement>(),heads=new Map<string,HTMLButtonElement>(),progress={value:0};
    const labels=new Map<string,{width:number;height:number;body:number}>();
    const edges=model.edges.map(networkEdge),items:AccumulationNode[]=model.items;
    let tick:((time:number)=>void)|undefined;

    function layout() {
      const w=host.clientWidth,h=host.clientHeight,top=model.overview?35:92,bottom=68;
      if(model.overview) {
        anchors=new Map(items.map(n=>[n.id,model.positions[n.id] as Point]));
        return;
      }
      anchors=new Map(items.map(n=>{const [x,y]=model.positions[n.id],el=dom.get(n.id),half=(el?.offsetWidth||160)/2;
        return [n.id,[Math.max(half+18,Math.min(w-half-18,w*x)),top+(h-top-bottom)*y] as Point];}));
      // The focused view reserves measured names as well as node bodies.
      const placed:{hw:number;hh:number;point:Point}[]=model.heads.map((head:any)=>({
        hw:(heads.get(head.kind)?.offsetWidth||140)/2+10,hh:(heads.get(head.kind)?.offsetHeight||42)/2+9,
        point:[head.x*w,35+(h-103)*head.y] as Point,
      }));
      for(const n of items) {
        const el=dom.get(n.id),hw=(el?.offsetWidth||160)/2+12,hh=(el?.offsetHeight||95)/2+12,origin=anchors.get(n.id)!;
        let best=origin,penalty=Infinity;
        for(let attempt=0;attempt<750;attempt++) {
          const radius=attempt?13*Math.sqrt(attempt):0,angle=attempt*2.39996323;
          const point:Point=[Math.max(hw+10,Math.min(w-hw-10,origin[0]+Math.cos(angle)*radius)),Math.max(hh+(model.overview?12:63),Math.min(h-hh-61,origin[1]+Math.sin(angle)*radius))];
          const overlap=placed.reduce((sum,b)=>sum+Math.max(0,hw+b.hw-Math.abs(point[0]-b.point[0]))*Math.max(0,hh+b.hh-Math.abs(point[1]-b.point[1])),0);
          if(overlap<penalty){best=point;penalty=overlap;}
          if(!overlap)break;
        }
        anchors.set(n.id,best);placed.push({hw,hh,point:best});
      }
    }
    function sync() {
      if(!g||g.destroyed||disposed)return;
      // Read layout once before writing styles. Reading host size inside the
      // collision loops used to force layout repeatedly for every label.
      const width=host.clientWidth,height=host.clientHeight;
      const z=g.getZoom(),scale=model.overview?Math.max(.62,Math.min(1.12,Math.pow(z,.65))):Math.max(.8,Math.min(1.12,z));
      const origin=g.getViewportByCanvas([0,0]);
      const project=(p:Point):Point=>[origin[0]+p[0]*z,origin[1]+p[1]*z];
      const percent=`${Math.round(z*100)}%`;
      if(zoomLabel.current&&zoomLabel.current.textContent!==percent)zoomLabel.current.textContent=percent;
      if(model.overview)overlay.style.setProperty('--label-scale',String(1/scale));
      const screen=new Map<string,Point>();
      for(const [id,p] of positions) {const el=dom.get(id),v=project(p);screen.set(id,v);
        if(el)el.style.transform=`translate(${v[0]}px,${v[1]}px) translate(-50%,-50%) scale(${scale})`;}
      if(model.overview){
        const active=prefs.current.hot||prefs.current.selected,near=active?data.neighbourIds(active):null;
        const first=screen.get(items[0]?.id),nextKey=`${active}|${z.toFixed(2)}|${Math.round((first?.[0]||0)/14)}:${Math.round((first?.[1]||0)/14)}|${width}`;
        const now=performance.now();
        // The camera and nodes remain frame-synchronous. Name placement can
        // stay stable during a camera move, then settle once it finishes.
        if(nextKey===labelKey||(active===lastLabelActive&&(focusMotion||now-lastLabelTime<140)))return;
        labelKey=nextKey;lastLabelTime=now;lastLabelActive=active;
        const ranked=[...items].sort((a,b)=>{
          const rank=(n:AccumulationNode)=>(n.id===active?10000:near?.has(n.id)?1000:0)+(model.sourceCounts[n.id]>=2?500:0)+(model.degree[n.id]||0)*10;
          return rank(b)-rank(a)||a.id.localeCompare(b.id);
        });
        const occupied:{x:number;y:number;w:number;h:number}[]=[];
        for(const n of ranked){const el=dom.get(n.id)!,p=screen.get(n.id)!,r=labels.get(n.id)!.body*scale/2+7;
          const {width:w,height:h}=labels.get(n.id)!;
          const candidates=[{x:p[0]-w/2,y:p[1]+r,w,h},{x:p[0]-w/2,y:p[1]-r-h,w,h},
            {x:p[0]+r,y:p[1]-h/2,w,h},{x:p[0]-r-w,y:p[1]-h/2,w,h}];
          const scores=candidates.map(box=>{
            let penalty=box.x<10||box.x+w>width-10||box.y<55||box.y+h>height-62?10000:0;
            const overlap=(b:{x:number;y:number;w:number;h:number})=>Math.max(0,Math.min(box.x+w,b.x+b.w)-Math.max(box.x,b.x))*Math.max(0,Math.min(box.y+h,b.y+b.h)-Math.max(box.y,b.y));
            for(const b of occupied)penalty+=overlap({x:b.x-4,y:b.y-3,w:b.w+8,h:b.h+6})*2;
            for(const other of items){if(other.id===n.id)continue;const q=screen.get(other.id)!,s=labels.get(other.id)!.body*scale/2+2;penalty+=overlap({x:q[0]-s,y:q[1]-s,w:s*2,h:s*2});}
            return {box,penalty};
          }).sort((a,b)=>a.penalty-b.penalty);
          const {box,penalty}=scores[0],visible=n.id===active||model.role[n.id]==='hub'||!penalty;
          el.dataset.named=String(visible);el.dataset.near=String(!near||near.has(n.id));
          el.style.setProperty('--label-x',`${(box.x+w/2-p[0])/scale}px`);el.style.setProperty('--label-y',`${(box.y-p[1])/scale}px`);
          if(visible)occupied.push(box);
        }
      }
      for(const head of model.heads) {const el=heads.get(head.kind),v=project([head.x,head.y]);
        if(el)el.style.transform=`translate(${v[0]}px,${v[1]}px) translate(-50%,-50%) scale(${z})`;}
    }
    function cancelFocus() {focusTween?.kill();focusTween=null;focusMotion=null;viewportDirty=true;labelKey='';}
    function reveal(id:string,delay=0) {
      cancelFocus();
      if(!g||g.destroyed||disposed||!positions.has(id))return;
      const motion={id,point:positions.get(id)!,progress:0,fromZoom:1,toZoom:1,from:[0,0] as Point,to:[0,0] as Point};
      function begin() {
        if(!g||g.destroyed||disposed)return;
        motion.point=positions.get(id)!;
        const [x,y]=g.getViewportByCanvas(motion.point),w=host.clientWidth,h=host.clientHeight;
        motion.fromZoom=g.getZoom();motion.toZoom=Math.max(.85,motion.fromZoom);
        motion.from=[x,y];
        motion.to=motion.fromZoom<.85||x<130||x>w-130||y<95||y>h-90?[w/2,h*.48]:[x,y];
        focusMotion=motion;
      }
      // Let the details open first. Capture the camera after that resize, not
      // before it, and let the existing render loop move both nodes and edges.
      if(prefs.current.reduced){begin();motion.progress=1;return;}
      focusTween=gsap.to(motion,{progress:1,delay,duration:.42,ease:'power1.out',onStart:begin});
    }
    async function advanceFocus() {
      const motion=focusMotion;
      if(!motion||!g||g.destroyed||disposed)return;
      const p=prefs.current.reduced?1:motion.progress,point=motion.point;
      const origin=g.getViewportByCanvas(point);
      await g.zoomTo(motion.fromZoom*Math.pow(motion.toZoom/motion.fromZoom,p),false,origin);
      if(disposed||focusMotion!==motion)return;
      const actual=g.getViewportByCanvas(point);
      await g.translateBy([motion.from[0]+(motion.to[0]-motion.from[0])*p-actual[0],motion.from[1]+(motion.to[1]-motion.from[1])*p-actual[1]],false);
      if(p>=1&&focusMotion===motion){focusMotion=null;labelKey='';}
    }
    async function fitOverview(animate=true,delay=0) {
      cancelFocus();
      if(!g||g.destroyed||disposed)return;
      const points=[...anchors.values()],xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
      const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
      const motion={point:[(left+right)/2,(top+bottom)/2] as Point,progress:0,fromZoom:1,toZoom:1,from:[0,0] as Point,to:[0,0] as Point};
      const begin=()=>{
        if(!g||g.destroyed||disposed)return;
        const w=host.clientWidth,h=host.clientHeight;
        motion.fromZoom=g.getZoom();motion.toZoom=Math.max(.06,Math.min(1,(w-160)/Math.max(1,right-left),(h-150)/Math.max(1,bottom-top)));
        const at=g.getViewportByCanvas(motion.point);motion.from=[at[0],at[1]];motion.to=[w/2,h/2];focusMotion=motion;
      };
      if(!animate||prefs.current.reduced){begin();motion.progress=1;await advanceFocus();return;}
      focusTween=gsap.to(motion,{progress:1,delay,duration:.46,ease:'power1.out',onStart:begin});
    }
    function fail() {
      if(disposed||failed)return;failed=true;
      if(tick)gsap.ticker.remove(tick);tween.current?.kill();cancelFocus();scene.current=null;
      setError('地图连线暂未显示，仍可点开条目查看关联，或跳转到列表。');setReady(true);
      if(g&&!g.destroyed)g.destroy();
    }
    async function restage(force=false) {
      if(!g||g.destroyed||disposed||drawing||!host.clientWidth||!host.clientHeight)return;
      const size=`${host.clientWidth}:${host.clientHeight}`;if(!force&&size===lastSize)return;
      drawing=true;
      try {
        const origin=model.overview?g.getViewportByCanvas([0,0]):null;
        lastSize=size;g.setSize(host.clientWidth,host.clientHeight);
        // Resizing for the sidebar must crop/reveal the same map, not move it.
        if(origin){const next=g.getViewportByCanvas([0,0]);await g.translateBy([origin[0]-next[0],origin[1]-next[1]],false);if(disposed)return;}
        if(!model.overview){layout();positions=new Map(anchors);}
        g.updateNodeData([...positions].map(([id,[x,y]])=>({id,style:{x,y}})));
        if(!model.overview){await g.zoomTo(1,false);if(disposed)return;await g.translateTo([0,0],false);if(disposed)return;}
        await g.draw();if(disposed)return;viewportDirty=true;sync();
      } finally {drawing=false;}
    }
    async function start() {
      await document.fonts.ready;if(disposed)return;
      if(!host.clientWidth||!host.clientHeight)await new Promise<void>(resolve=>{
        waitSize=new ResizeObserver(()=>{if(host.clientWidth&&host.clientHeight){waitSize?.disconnect();resolve();}});waitSize.observe(host);
        abort.signal.addEventListener('abort',()=>resolve(),{once:true});
      });
      if(disposed)return;
      overlay.querySelectorAll<HTMLButtonElement>('[data-node-id]').forEach(el=>dom.set(el.dataset.nodeId!,el));
      overlay.querySelectorAll<HTMLButtonElement>('[data-group-id]').forEach(el=>heads.set(el.dataset.groupId!,el));
      dom.forEach((el,id)=>{const label=el.querySelector<HTMLElement>('.ac-node-content')!;labels.set(id,{width:label.offsetWidth,height:label.offsetHeight,body:el.offsetWidth});});
      layout();positions=new Map(anchors);lastSize=`${host.clientWidth}:${host.clientHeight}`;
      for(const [id,[x,y]] of positions)dom.get(id)!.style.transform=`translate(${x}px,${y}px) translate(-50%,-50%)`;
      g=new Graph({container:canvas.current!,width:host.clientWidth,height:host.clientHeight,animation:false,
        data:{nodes:items.map(n=>({id:n.id,style:{x:positions.get(n.id)![0],y:positions.get(n.id)![1],size:[dom.get(n.id)!.offsetWidth+12,dom.get(n.id)!.offsetHeight+8]}})),edges},
        layout:model.overview?{type:'d3-force',preLayout:true,animation:false,iterations:280,center:false,
          manyBody:{strength:-460,distanceMax:1300},link:{distance:170,strength:.6},collide:{radius:58,strength:1,iterations:3},
          x:{x:0,strength:.001},y:{y:0,strength:.07},alphaDecay:.035,velocityDecay:.5}:undefined,
        node:{type:'rect',style:{fill:'transparent',stroke:'transparent',radius:18,pointerEvents:'none'}},
        edge:{type:model.overview?'line':'cubic-horizontal',style:{stroke:(e:any)=>e.style?.stroke||tones[e.tone],lineWidth:(e:any)=>e.style?.lineWidth??1.6,opacity:(e:any)=>e.style?.opacity??.4,
          labelText:(e:any)=>e.style?.labelText??'',labelFontFamily:'MiSans',labelFontSize:(e:any)=>e.style?.labelFontSize??12,labelFill:(e:any)=>tones[e.tone],labelAutoRotate:false,labelBackground:true,labelBackgroundFill:'#fbfcf9',labelPadding:[4,7],labelOffsetY:-10,
          lineDash:(e:any)=>e.style?.lineDash??dashes[e.tone],lineDashOffset:(e:any)=>e.style?.lineDashOffset||0,endArrow:(e:any)=>!model.overview&&e.tone!=='related',endArrowSize:6}},
        behaviors:[{type:'drag-canvas'},{type:'zoom-canvas',sensitivity:.4}],zoomRange:[model.overview?.06:.7,1.8]});
      await g.render();if(disposed)return;
      if(model.overview){
        anchors=new Map(g.getNodeData().map(n=>[n.id,[Number(n.style!.x),Number(n.style!.y)] as Point]));
        // Graph distances have no metric meaning. Expand the force result to
        // the desktop canvas instead of shrinking a round cloud into its middle.
        const points=[...anchors.values()],xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
        const aspect=(Math.max(...xs)-Math.min(...xs))/Math.max(1,Math.max(...ys)-Math.min(...ys));
        const stretch=Math.max(1,Math.min(3,(host.clientWidth-160)/(host.clientHeight-150)/aspect));
        if(items.length>12)anchors=new Map([...anchors].map(([id,[x,y]])=>[id,[x*stretch,y] as Point]));
        positions=new Map(anchors);g.updateNodeData([...anchors].map(([id,[x,y]])=>({id,style:{x,y}})));await g.draw();if(disposed)return;
      }
      // Coalesce zoom + pan + drawing into one DOM sync, not one per event.
      g.on('beforetransform',()=>{externalMoving=true;});
      g.on('aftertransform',()=>{externalMoving=false;viewportDirty=true;});
      scene.current={
        zoom:async factor=>{cancelFocus();if(!g||g.destroyed)return;try{await g.zoomTo(Math.max(model.overview?.06:.7,Math.min(1.8,g.getZoom()*factor)),prefs.current.reduced?false:{duration:180});}catch{fail();}},
        reset:async(animate=true,delay=0)=>{try{if(!model.overview){cancelFocus();await restage(true);return;}await fitOverview(animate,delay);}catch{fail();}},
        focus:reveal,cancelFocus,finishFocus:()=>{focusTween?.progress(1);},
      };
      if(model.overview)await scene.current.reset(returnKey!==lastReturn.current);if(disposed||failed)return;
      lastReturn.current=returnKey;lastModel.current=model;
      setReady(true);sync();
      tween.current=gsap.to(progress,{value:1,duration:prefs.current.reduced||prefs.current.paused?0:1.4,ease:'power2.out'});
      host.addEventListener('pointermove',e=>{const b=host.getBoundingClientRect();pointer=[e.clientX-b.left,e.clientY-b.top];},{signal:abort.signal});
      host.addEventListener('pointerleave',()=>pointer=null,{signal:abort.signal});
      host.addEventListener('pointerdown',cancelFocus,{signal:abort.signal});
      host.addEventListener('wheel',cancelFocus,{signal:abort.signal,passive:true});
      resize=new ResizeObserver(()=>{void restage().catch(fail);});resize.observe(host);
      intersection=new IntersectionObserver(([e])=>{inView=e.isIntersecting;last=0;});intersection.observe(host);
      tick=async time=>{
        if(disposed||failed||drawing||!inView||document.hidden)return;
        if(lastSize!==`${host.clientWidth}:${host.clientHeight}`){void restage().catch(fail);return;}
        drawing=true;
        try{
        if(focusMotion)await advanceFocus();
        if(disposed||failed)return;
        const dt=last?Math.min(.08,time-last):0;last=time;
        const {reduced:quiet,paused:still,hot:hover,selected:chosen}=prefs.current;
        if(!still&&!quiet)clock+=dt;
        const active=hover||chosen,connected=active?data.neighbourIds(active):null;
        if(active!==lastActive){hoverClock=0;lastActive=active;}else if(!still&&!quiet)hoverClock=Math.min(1,hoverClock+dt);
        const moving=!!focusMotion||externalMoving,z=g!.getZoom(),origin=g!.getViewportByCanvas([0,0]);
        const p=quiet?1:progress.value,finishReveal=p>=1&&!entranceDone;
        const key=`${active}|${p.toFixed(3)}|${moving?'camera':hoverClock.toFixed(2)}|${quiet}|${still}|${moving?'camera':z.toFixed(2)}`;
        const changed=key!==lastKey,driftDue=!moving&&time-lastDrift>=1/30;
        if(driftDue)lastDrift=time;
        const updates:any[]=[];
        if(driftDue||changed||finishReveal)items.forEach((n,i)=>{
          const a=anchors.get(n.id)!,old=positions.get(n.id)!,el=dom.get(n.id)!,viewport=[origin[0]+old[0]*z,origin[1]+old[1]*z];
          const freeze=active===n.id||chosen===n.id||focusMotion?.id===n.id||(pointer&&Math.hypot(viewport[0]-pointer[0],viewport[1]-pointer[1])<110);
          let next=old;
          if(p<1){const start=previous.current.get(n.id)||anchors.get(model.focus)||[a[0],a[1]-25];next=[start[0]+(a[0]-start[0])*p,start[1]+(a[1]-start[1])*p];}
          else if(driftDue&&!quiet&&!still&&!freeze){const amplitude=model.overview?Math.min(24,5/z):6;
            const target=[a[0]+Math.sin(clock*.55+i*1.9)*amplitude,a[1]+Math.cos(clock*.6+i*1.3)*amplitude*.83];next=[old[0]+(target[0]-old[0])*.12,old[1]+(target[1]-old[1])*.12];}
          if(quiet||finishReveal)next=a;
          if(Math.hypot(next[0]-old[0],next[1]-old[1])>.1){positions.set(n.id,next);updates.push({id:n.id,style:{x:next[0],y:next[1]}});}
          const phase=previous.current.has(n.id)?0:Math.min(.35,i*.018);
          if(changed)el.style.opacity=String((connected&&!connected.has(n.id)?model.overview?.4:.72:1)*(previous.current.has(n.id)?1:Math.min(1,Math.max(0,(p-phase)/(1-phase)))));
        });
        if(finishReveal)entranceDone=true;
        if(changed){
          const activeDegree=active?data.adjacent(active).length:0;
          g!.updateEdgeData(edges.map((e:any)=>{
            const direct=!model.overview&&(e.source===model.focus||e.target===model.focus),near=active&&(e.source===active||e.target===active);
            const a=anchors.get(e.source)!,b=anchors.get(e.target)!,length=Math.hypot(a[0]-b[0],a[1]-b[1])*1.6;
            const strokeScale=model.overview?1/g!.getZoom():1;
            return {id:e.id,style:{opacity:model.overview?(active?(near?.94:.10):.52):active?(near?.98:.10):direct?.95:.45,stroke:tones[e.tone],
              labelText:!moving&&(direct||(near&&(!model.overview||activeDegree<=6)))?localizeText(e.label):'',labelFontSize:12*strokeScale,lineWidth:(near?2:direct?1.9:1.05)*strokeScale,
              lineDash:p<1?[length,length]:dashes[e.tone].map(n=>n*strokeScale),lineDashOffset:p<1?length*(1-p):near&&e.tone==='used'&&!quiet?-36*hoverClock*strokeScale:0}};
          }));lastKey=key;
        }
        if(updates.length)g!.updateNodeData(updates);
        if(updates.length||changed)await g!.draw();
        if(updates.length||changed||viewportDirty||externalMoving){viewportDirty=false;sync();}
        }catch{fail();}finally{drawing=false;}
      };
      gsap.ticker.add(tick);
    }
    setReady(false);setError('');setHot(null);start().catch(fail);
    return()=>{previous.current=new Map(positions);disposed=true;cancelFocus();abort.abort();waitSize?.disconnect();resize?.disconnect();intersection?.disconnect();tween.current?.kill();if(tick)gsap.ticker.remove(tick);if(g&&!g.destroyed)g.destroy();scene.current=null;};
  },[data,model]);

  useEffect(()=>{if(reduced||paused)tween.current?.progress(1).pause();else tween.current?.resume();if(reduced)scene.current?.finishFocus();},[paused,reduced]);
  useEffect(()=>{
    if(!ready||lastModel.current!==model)return;
    if(model.overview&&selected)scene.current?.focus(selected,hadSelection.current?0:.08);
    else if(model.overview&&(hadSelection.current||returnKey!==lastReturn.current))void scene.current?.reset(true);
    else if(!model.overview)scene.current?.cancelFocus();
    hadSelection.current=!!selected;lastReturn.current=returnKey;
  },[selected,ready,model,returnKey]);
  useGSAP(()=>{
    if(!ready)return;
    gsap.to('.ac-node-face',{y:0,scale:1,duration:reduced?0:.23,overwrite:true});
    const target=Array.from(root.current!.querySelectorAll<HTMLElement>('[data-node-id]')).find(el=>el.dataset.nodeId===hot)?.firstElementChild;
    if(target)gsap.to(target,{y:reduced?0:-5,scale:reduced?1:1.025,duration:reduced?0:.3,ease:'back.out(1.5)',overwrite:true});
  },{scope:root,dependencies:[hot,ready,reduced],revertOnUpdate:true});

  return <div ref={root} className={`ac-scene ${model.overview?'is-overview':'is-network'} ${error?'has-error':''}`} data-ready={ready}>
    <div className="ac-scene-wash" aria-hidden="true"/>
    <div className="ac-relation-key"><span className="ac-key-formed"><i/>来源 / 学到</span><span className="ac-key-used"><i/>在任务中用过</span><Popover.Root><Popover.Trigger className="ac-key-help" aria-label="连线怎么看"><Info size={16}/></Popover.Trigger><Popover.Portal><Popover.Content className="help-bubble" align="start" sideOffset={8}><strong>两种不同的联系</strong><p>绿色实线表示内容的来源或形成；蓝色虚线表示已有积累在任务中被用过。灰线表示其他已记录的联系。</p><p>带绿色分支标记的内容是多项积累的共同来源。图中的大节点或当前位置，不一定是来源。</p><p>箭头不表示任务正在运行，也不说明使用结果一定成功。点开条目可查看记录。</p></Popover.Content></Popover.Portal></Popover.Root></div>
    {!model.overview&&model.pages>1&&<div className="ac-relation-pages"><span>关联内容 {model.range[0]}–{model.range[1]} / {model.neighbourCount}</span><button aria-label="上一组联系" disabled={!model.page} onClick={()=>onPage(model.page-1)}><ChevronLeft size={17}/></button><b>{model.page+1} / {model.pages}</b><button aria-label="下一组联系" disabled={model.page===model.pages-1} onClick={()=>onPage(model.page+1)}><ChevronRight size={17}/></button></div>}
    <div ref={canvas} className="ac-scene-canvas" aria-hidden="true"/>
    <div ref={layer} className="ac-scene-nodes">
      {model.heads.map((head:any)=><button key={head.kind} data-group-id={head.kind} className="ac-group" style={{'--kind':kinds[head.kind].color} as CSSProperties} onClick={()=>onGroup(head.kind)}><span>{kinds[head.kind].label}<b>{head.count}</b><ArrowUpRight size={15}/></span><small>{collectionDescriptions[head.kind]}</small></button>)}
      {model.items.map((node:AccumulationNode)=>{const Icon=accumulationIcons[node.kind],isFocus=node.id===model.focus,sourceCount=model.sourceCounts[node.id]||0,sharedSource=sourceCount>=2;
        return <button key={node.id} data-node-id={node.id} data-role={model.role[node.id]} data-kind={node.kind} data-source={sharedSource} data-selected={selected===node.id} className="ac-scene-node" style={{'--kind':kinds[node.kind].color,'--tint':kinds[node.kind].tint} as CSSProperties}
          aria-label={`${localizeText(kinds[node.kind].label)}：${node.title}${sharedSource?' · '+localizeText('共同来源'):''}`} aria-pressed={selected===node.id} title={node.title} onClick={()=>onSelect(node.id)} onPointerEnter={()=>setHot(node.id)} onPointerLeave={()=>setHot(null)} onFocus={event=>{setHot(node.id);if(model.overview&&event.currentTarget.matches(':focus-visible'))void scene.current?.focus(node.id);}} onBlur={()=>setHot(null)}>
          <span className="ac-node-face"><span className="ac-node-icon"><Icon size={isFocus?28:20} strokeWidth={1.65}/>{sharedSource&&<span className="ac-source-symbol" aria-hidden="true"><GitBranch size={12}/></span>}</span><span className="ac-node-content">{!model.overview&&<small>{model.badges[node.id]||(isFocus?'当前查看':kinds[node.kind].label)}</small>}<strong><SourceText>{node.title}</SourceText></strong>{sharedSource&&<small className="ac-source-badge">共同来源 · {sourceCount} 项</small>}{model.hidden[node.id]>0&&<span className="ac-node-more">另有 {model.hidden[node.id]} 项关联</span>}</span><ArrowUpRight className="ac-node-arrow" size={15}/></span>
        </button>;
      })}
    </div>
    {model.noRelations&&<div className="ac-no-relations">还没有关联记录，不影响这条积累的使用。</div>}
    {!ready&&<div className="ac-map-loading" role="status">正在展开积累地图…</div>}
    {error&&<p className="ac-scene-error" role="status">{error}</p>}
    <div className="ac-scene-foot"><span>{model.overview?'沿着连线看积累。放大看名称，点开看任务记录。':'点内容看任务记录，再从侧栏查看完整内容。'}</span><div className="ac-scene-controls">
      {!reduced&&<><button onClick={onPause} aria-label={paused?'继续动效':'暂停动效'} aria-pressed={paused}>{paused?<Play size={16}/>:<Pause size={16}/>}</button><i/></>}
      <button disabled={!!error} aria-label="缩小地图" onClick={()=>void scene.current?.zoom(1/1.15)}><ZoomOut size={17}/></button><span ref={zoomLabel}>100%</span><button disabled={!!error} aria-label="放大地图" onClick={()=>void scene.current?.zoom(1.15)}><ZoomIn size={17}/></button><button disabled={!!error} aria-label={model.overview?'查看全图':'居中显示'} title={localizeText(model.overview?'查看全图':'居中显示')} onClick={()=>void scene.current?.reset()}><Scan size={17}/></button>
    </div></div>
  </div>;
}
