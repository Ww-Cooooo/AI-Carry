import { kinds } from './accumulation-data.mjs';

const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const mix=(a,b,t)=>a+(b-a)*t;
const blend=(a,b,t)=>'#'+[1,3,5].map(i=>Math.round(mix(parseInt(a.slice(i,i+2),16),parseInt(b.slice(i,i+2),16),t)).toString(16).padStart(2,'0')).join('');

let labelsRegistered=false;
function registerMapLabels({AutoAdaptLabel,register,ExtensionCategory}){
  if(labelsRegistered)return;
  class MapLabels extends AutoAdaptLabel{
    constructor(context,options){
      super(context,options);
      const sort=this.sortLabelElementsInView;
      // G6 already avoids label/label collisions. Also reserve the nodes' space
      // so a long title cannot cover a different node's clickable icon.
      this.sortLabelElementsInView=elements=>{
        const bounds=context.graph.getNodeData().map(n=>context.element.getElement(n.id)).filter(n=>n?.isVisible()).map(n=>({id:n.id,box:n.getShape('key').getRenderBounds()}));
        return sort(elements).filter(el=>{
          const label=el.getShape('label'),box=label.getRenderBounds();
          if(bounds.some(b=>b.id!==el.id&&box.intersects(b.box))){label.style.visibility='hidden';return false;}
          return true;
        });
      };
    }
  }
  register(ExtensionCategory.BEHAVIOR,'accumulation-labels',MapLabels);labelsRegistered=true;
}

// The camera fits the natural layout, never compresses its coordinates. One
// scheduler owns idle drift and bounded force response; they never run together.
export async function createMapScene({Graph,D3ForceLayout,AutoAdaptLabel,register,ExtensionCategory,host,frame,sample,iconImages,shortTitles,signal,onSelect,onHover,onZoom,onError,onHint,reduced}){
  registerMapLabels({AutoAdaptLabel,register,ExtensionCategory});
  const {nodes,edges,neighbourIds}=sample;
  const byId=new Map(nodes.map(n=>[n.id,n])),degree=new Map(nodes.map(n=>[n.id,0]));
  edges.forEach(e=>{degree.set(e.source,degree.get(e.source)+1);degree.set(e.target,degree.get(e.target)+1);});
  let g,raf=0,observer,intersection,destroyed=false,busy=false,initialized=false;
  let selected=null,hovered=null,pointer=null,dragging=null,settling=false;
  let shown=new Set(nodes.map(n=>n.id)),stylesDirty=true,needsFit=false;
  let paused=false,offscreen=false,lastFrame=0,clock=0,lastZoom=0;
  const anchors=new Map(),positions=new Map();
  const force=new D3ForceLayout({center:false,manyBody:{strength:-580,distanceMax:1100},
    link:{distance:180,strength:.075},edgeId:e=>e.id,collide:{radius:72,strength:1,iterations:2},
    x:{x:n=>byId.get(n.id).x*1.25,strength:.035},y:{y:n=>byId.get(n.id).y*1.1,strength:.035},alphaDecay:.06,velocityDecay:.48});
  // AntV initializes synchronously before its end promise. Stop the internal
  // timer and perform bounded ticks, as G6's pre-layout does.
  force.execute({nodes:nodes.map(n=>({id:n.id,x:n.x*1.25,y:n.y*1.1})),edges:edges.map(e=>({id:e.id,source:e.source,target:e.target}))}).catch(e=>{if(!destroyed)onError(e.message);});
  force.stop();force.tick(220);
  force.forEachNode(n=>{anchors.set(n.id,[n.x,n.y]);positions.set(n.id,[n.x,n.y]);});

  function dispose(){
    if(destroyed)return;destroyed=true;cancelAnimationFrame(raf);observer?.disconnect();intersection?.disconnect();
    host.removeEventListener('pointermove',trackPointer);host.removeEventListener('pointerleave',leavePointer);
    document.removeEventListener('visibilitychange',wake);force.stop();force.destroy();if(g&&!g.destroyed)g.destroy();
  }
  signal.addEventListener('abort',dispose,{once:true});
  function fail(e){if(!destroyed)onError(e.message||String(e));}
  function wake(){lastFrame=0;request();}
  function request(){if(!destroyed&&!raf)raf=requestAnimationFrame(t=>{raf=0;step(t).catch(fail);});}
  function trackPointer(e){const b=host.getBoundingClientRect();pointer=[e.clientX-b.left,e.clientY-b.top];}
  function leavePointer(){pointer=null;setHover(null);}
  function setHover(id){
    if(hovered===id)return;hovered=id;stylesDirty=true;
    if(id){const n=byId.get(id),p=g.getViewportByCanvas(g.getElementPosition(id));onHover({title:n.title,kind:kinds[n.kind].label,x:clamp(p[0],140,frame.clientWidth-140),y:clamp(p[1]-64,10,frame.clientHeight-82)});}
    else onHover(null);request();
  }
  function presentation(){
    const z=g.getZoom(),detail=smooth(.28,.9,z),icon=smooth(.32,.56,z),label=smooth(.46,.68,z);
    const active=hovered||selected,neighbours=active?neighbourIds(active):null;
    return {nodes:nodes.map(n=>{
      const c=kinds[n.kind],task=n.kind==='task',hot=n.id===hovered,picked=n.id===selected;
      const connected=!active||neighbours.has(n.id),dot=mix(4.5,8,smooth(.08,.26,z)),diameter=mix(dot,46,detail)*(task?1.15:1)+(hot?5:picked?3:0);
      return {id:n.id,style:{visibility:shown.has(n.id)?'visible':'hidden',size:diameter/z,opacity:connected?1:picked?.55:.18,
        fill:task?'#416bc6':blend(c.color,c.tint,detail),stroke:hot||picked?c.color:blend(c.color,c.tint,detail*.65),lineWidth:(hot||picked?1.8:1)/z,
        shadowColor:c.color+(hot?'4a':'20'),shadowBlur:(hot?16:mix(5,9,detail))/z,shadowOffsetY:0,
        halo:hot||picked,haloStroke:c.color,haloLineWidth:7/z,haloStrokeOpacity:.13,increasedLineWidthForHitTesting:Math.max(0,10-diameter)/z,
        iconSrc:iconImages[n.kind],iconWidth:diameter*.52/z,iconHeight:diameter*.52/z,iconOpacity:icon,
        labelText:label>0||picked?(shortTitles[n.id]||n.title):'',labelOpacity:picked?1:label,
        labelFontFamily:'MiSans',labelFontSize:14/z,labelLineHeight:18/z,labelFontWeight:task||picked?500:400,labelFill:'#354461',labelFillOpacity:1,labelPlacement:'bottom',labelOffsetY:9/z,
        labelBackground:true,labelBackgroundFill:'#fafbf8',labelBackgroundOpacity:.94,labelPadding:[3/z,6/z],labelBorderRadius:5/z,cursor:'pointer',draggable:true}};
    }),edges:edges.map(e=>{
      const connected=active&&(e.source===active||e.target===active);
      return {id:e.id,style:{visibility:shown.has(e.source)&&shown.has(e.target)?'visible':'hidden',opacity:active?(connected?.85:.035):mix(.20,.42,detail),
        lineWidth:(connected?1.35:.8)/z,labelText:connected&&z>.58?e.label:'',labelFontSize:12/z,labelPadding:[3/z,6/z],labelBorderRadius:4/z}};
    })};
  }
  async function fit(){
    if(destroyed||!shown.size)return;
    const ps=[...shown].map(id=>g.getElementPosition(id)),xs=ps.map(p=>p[0]),ys=ps.map(p=>p[1]);
    const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    const z=clamp(Math.min(1.1,(frame.clientWidth-110)/(maxX-minX+160),(frame.clientHeight-95)/(maxY-minY+170)),.08,2.5);
    await g.zoomTo(z,false);if(destroyed)return;
    const c=g.getViewportByCanvas([(minX+maxX)/2,(minY+maxY)/2]);
    await g.translateBy([frame.clientWidth/2-c[0],(frame.clientHeight-20)/2-c[1]],false);stylesDirty=true;request();
  }
  function frozen(id,p){
    if(id===selected||id===hovered)return true;if(!pointer)return false;
    const v=g.getViewportByCanvas(p);return Math.hypot(v[0]-pointer[0],v[1]-pointer[1])<65;
  }
  function moveNodes(dt){
    const updates=[];
    if(dragging||settling){
      // G6 moves the dragged node. The force solver follows that exact position
      // and moves its surroundings. Idle motion is disabled during this phase.
      for(const n of force.nodes()){
        const p=n.id===dragging?g.getElementPosition(n.id):positions.get(n.id);
        force.setFixedPosition(n.id,n.id===dragging||frozen(n.id,p)?p:null);
      }
      force.setAlpha(Math.max(force.getAlpha(),dragging?.12:0));force.tick(1);
      force.forEachNode(n=>{const p=n.id===dragging?g.getElementPosition(n.id):[n.x,n.y];positions.set(n.id,p);if(n.id!==dragging)updates.push({id:n.id,style:{x:p[0],y:p[1]}});});
      if(!dragging&&force.getAlpha()<.003){settling=false;positions.forEach((p,id)=>anchors.set(id,[...p]));force.nodes().forEach(n=>force.setFixedPosition(n.id,null));}
    }else{
      const ease=1-Math.exp(-dt*2.8);
      nodes.forEach((n,i)=>{
        const p=positions.get(n.id),base=anchors.get(n.id);if(!shown.has(n.id)||frozen(n.id,p))return;
        const v=g.getViewportByCanvas(p);if(v[0]<-80||v[1]<-80||v[0]>frame.clientWidth+80||v[1]>frame.clientHeight+80)return;
        const next=[mix(p[0],base[0]+Math.sin(clock*.39+i*2.4)*13,ease),mix(p[1],base[1]+Math.cos(clock*.32+i*1.7)*11,ease)];
        positions.set(n.id,next);
        const drawn=g.getElementPosition(n.id);
        // Accumulate sub-pixel drift instead of repainting every record for a
        // visually imperceptible fraction of a pixel, especially in the overview.
        if(Math.hypot(next[0]-drawn[0],next[1]-drawn[1])*g.getZoom()>=.18)updates.push({id:n.id,style:{x:next[0],y:next[1]}});
      });
    }
    return updates;
  }
  async function step(now){
    if(destroyed||!initialized)return;if(busy){request();return;}
    const canMove=!document.hidden&&!offscreen&&!reduced&&!paused;
    if(!stylesDirty&&!needsFit&&!canMove)return;
    if(!stylesDirty&&!needsFit&&lastFrame&&now-lastFrame<40){request();return;}
    const dt=lastFrame?Math.min((now-lastFrame)/1000,.08):.04;lastFrame=now;busy=true;
    try{
      const refresh=stylesDirty||needsFit;
      if(stylesDirty){stylesDirty=false;const p=presentation();g.updateNodeData(p.nodes);g.updateEdgeData(p.edges);}
      let updates=[];if(canMove){clock+=dt;updates=moveNodes(dt);}
      // G6's translate path reuses rendered styles. Idle drift must not rebuild
      // every icon, font and state on each frame.
      if(refresh){g.updateNodeData(updates);await g.draw();}
      else if(updates.length)await g.translateElementTo(Object.fromEntries(updates.map(n=>[n.id,[n.style.x,n.style.y]])),false);
      if(destroyed)return;
      if(needsFit){needsFit=false;await fit();}
    }finally{busy=false;}
    if(canMove||stylesDirty||needsFit)request();
  }
  function startDrag(e){
    dragging=e.target.id;setHover(null);
    for(const n of force.nodes()){const p=g.getElementPosition(n.id);n.x=p[0];n.y=p[1];n.vx=0;n.vy=0;positions.set(n.id,p);}
    force.setAlpha(.18);request();
  }
  function endDrag(){
    if(!dragging)return;const id=dragging,p=g.getElementPosition(id);anchors.set(id,[...p]);positions.set(id,p);
    force.getForce('x').x(n=>anchors.get(n.id)[0]);force.getForce('y').y(n=>anchors.get(n.id)[1]);
    force.setFixedPosition(id,p);dragging=null;
    if(reduced||paused){force.setFixedPosition(id,null);settling=false;}else{settling=true;force.setAlpha(.12);}
    stylesDirty=true;request();
  }
  g=new Graph({container:host,width:frame.clientWidth,height:frame.clientHeight,animation:false,zoomRange:[.08,2.5],
    data:{nodes:nodes.map(n=>({id:n.id,data:{...n},style:{x:positions.get(n.id)[0],y:positions.get(n.id)[1]}})),edges:edges.map(e=>({...e,data:{kind:e.kind,label:e.label}}))},
    node:{type:'circle'},
    edge:{type:'quadratic',style:d=>({stroke:({learned:'#c58892',suggested:'#72a896',source:'#73a698',produced:'#73a698',related:'#a8bbcd'})[d.data.kind]||'#91add2',lineWidth:1,opacity:.2,curveOffset:10,
      lineDash:d.data.kind==='related'?[4,6]:undefined,labelFontFamily:'MiSans',labelFill:'#4a6595',labelBackground:true,labelBackgroundFill:'#fafbf8',labelAutoRotate:false,...d.style})},
    behaviors:[{type:'drag-canvas',key:'drag'},{type:'zoom-canvas',key:'zoom',sensitivity:.65},{type:'drag-element',key:'move'},
      {type:'accumulation-labels',key:'labels',padding:8,throttle:100,sortNode:(a,b)=>(b.id===selected?10000:degree.get(b.id))-(a.id===selected?10000:degree.get(a.id))}],
  });
  g.on('node:click',e=>{setHover(null);onSelect(e.target.id);});g.on('canvas:click',()=>onSelect(null));
  g.on('node:pointerenter',e=>{if(!dragging)setHover(e.target.id);});g.on('node:pointerleave',()=>setHover(null));
  g.on('node:dragstart',startDrag);g.on('node:dragend',endDrag);
  g.on('aftertransform',()=>{
    if(destroyed||!initialized)return;const zoom=g.getZoom();if(Math.abs(zoom-lastZoom)>.001){lastZoom=zoom;stylesDirty=true;onZoom(Math.round(zoom*100));}setHover(null);request();
  });
  await g.render();if(destroyed)return;initialized=true;await fit();
  host.addEventListener('pointermove',trackPointer);host.addEventListener('pointerleave',leavePointer);document.addEventListener('visibilitychange',wake);
  let width=frame.clientWidth,height=frame.clientHeight;
  observer=new ResizeObserver(()=>{if(frame.clientWidth===width&&frame.clientHeight===height)return;width=frame.clientWidth;height=frame.clientHeight;if(width&&height){g.setSize(width,height);needsFit=true;request();}});observer.observe(frame);
  intersection=new IntersectionObserver(([entry])=>{offscreen=!entry.isIntersecting;wake();});intersection.observe(frame);request();
  return {graph:g,
    setView({selected:next,visibleIds,focused,reduced:reduce,paused:pause}){
      const neighbours=next?neighbourIds(next):null,nextShown=new Set([...visibleIds].filter(id=>!focused||!next||neighbours.has(id)));
      const changed=nextShown.size!==shown.size||[...nextShown].some(id=>!shown.has(id));
      shown=nextShown;selected=next;reduced=reduce;paused=pause;stylesDirty=true;if(changed){setHover(null);needsFit=true;}request();
    },
    fit:()=>{needsFit=true;request();},
    zoom:factor=>g.zoomTo(clamp(g.getZoom()*factor,.08,2.5),reduced?false:{duration:220}).catch(()=>onHint('暂时无法缩放，内容仍可从列表查看。')),
    getPositions:()=>nodes.map(n=>({id:n.id,point:g.getViewportByCanvas(g.getElementPosition(n.id))})),
    getMotion:()=>({clock,dragging,settling,paused:paused||reduced||document.hidden||offscreen}),dispose};
}
