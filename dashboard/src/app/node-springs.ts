type Offset={x:number;y:number;vx:number;vy:number};
type Anchor={x:number;y:number;alpha:number};
type Pointer={x:number;y:number;active:boolean};
type Cohort={root:string;ids:string[]};

/** Bounded ambient and pointer response over recorded edges; never changes membership,
 * stored positions, selection or hit areas. GSAP owns the clock. */
export class NodeSprings {
  readonly offsets:Record<string,Offset>={};
  private readonly neighbors:Record<string,string[]>={};
  private readonly phases:Record<string,number>={};
  private readonly waves:Record<string,{phase:number;depth:number}>={};
  private readonly clearance:Record<string,number>={};
  private time=0;
  private age=0;
  constructor(readonly ids:string[],edges:{source:string;target:string}[],cohorts:Cohort[]=[]){
    for(const id of ids){this.offsets[id]={x:0,y:0,vx:0,vy:0};this.neighbors[id]=[];let seed=2166136261;for(const char of id)seed=Math.imul(seed^char.charCodeAt(0),16777619);this.phases[id]=(seed>>>0)/4294967296*Math.PI*2;}
    for(const edge of edges){this.neighbors[edge.source]?.push(edge.target);this.neighbors[edge.target]?.push(edge.source);}
    // Reuse the map's existing source membership. The wave only changes a
    // transient pose; it does not create edges or classify stored content.
    const distances=(root:string)=>{const result=new Map([[root,0]]),queue=[root];for(let i=0;i<queue.length;i++)for(const next of this.neighbors[queue[i]]||[]){if(!result.has(next)){result.set(next,result.get(queue[i])!+1);queue.push(next);}}return result;};
    let group=0;
    for(const cohort of cohorts){const distance=distances(cohort.root),phase=group++*2.7;for(const id of cohort.ids)if(this.offsets[id]&&distance.has(id))this.waves[id]={phase,depth:Math.min(4,distance.get(id)!)};}
    // Components without a source hub still follow only their recorded links.
    for(const root of [...ids].sort())if(!this.waves[root]){const distance=distances(root),phase=group++*2.7;for(const [id,depth]of distance)if(this.offsets[id]&&!this.waves[id])this.waves[id]={phase,depth:Math.min(4,depth)};}
  }

  reset(){for(const s of Object.values(this.offsets)){s.x=s.y=s.vx=s.vy=0;}this.age=0;}

  // Reserve each symbol's motion space after layout, not on every tick.
  // Two neighboring envelopes cannot consume their entire separating gap.
  setBounds(anchors:Record<string,Anchor>,radius:Record<string,number>){
    for(const id of this.ids)this.clearance[id]=Infinity;
    for(let i=0;i<this.ids.length;i++)for(let j=i+1;j<this.ids.length;j++){
      const aId=this.ids[i],bId=this.ids[j],a=anchors[aId],b=anchors[bId];
      if(!a||!b||a.alpha<.4||b.alpha<.4)continue;
      const gap=Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y))-radius[aId]-radius[bId];
      const room=Math.max(0,(gap-4)*.45);
      this.clearance[aId]=Math.min(this.clearance[aId],room);this.clearance[bId]=Math.min(this.clearance[bId],room);
    }
  }

  step(elapsed:number,anchors:Record<string,Anchor>,pointer:Pointer,zoom:number,selected:string|null,held:string|null=null){
    const dt=Math.min(Math.max(elapsed,0),.06),steps=Math.max(1,Math.ceil(dt*120)),h=dt/steps;
    this.time+=dt;this.age+=dt;let ambient=false;
    // Keep the gesture in screen space, with a smaller displacement in a
    // dense overview so the response stays proportional to its tiny symbols.
    const safeZoom=Math.max(.04,zoom),density=Math.max(.4,Math.min(1,safeZoom/.75));
    const radius=120/safeZoom,limit=36*density/safeZoom,targets:Record<string,{x:number;y:number}>={};
    for(const id of this.ids){
      const a=anchors[id];let x=0,y=0;
      if(a&&a.alpha>.4&&id!==selected&&id!==held){
        ambient=true;
        const room=Math.min(1,(this.clearance[id]??Infinity)/(32*density/safeZoom));
        const phase=this.phases[id],wave=this.waves[id],fade=Math.min(1,this.age/1.2),strength=(selected?.18:1)*density/safeZoom*fade*room;
        // The approved linked-motion sample: a shared slow wave, a slight
        // delay along real links, and a small individual variation.
        x=strength*(23*Math.sin(this.time*.82+wave.phase-wave.depth*.28)+4*Math.sin(this.time*1.3+phase));
        y=strength*(15*Math.cos(this.time*.66+wave.phase-wave.depth*.23)+3*Math.sin(this.time*.95+phase));
      }
      if(pointer.active&&a&&a.alpha>.4&&id!==selected&&id!==held){
        const offset=this.offsets[id],dx=a.x+offset.x-pointer.x,dy=a.y+offset.y-pointer.y,d=Math.hypot(dx,dy);
        if(d>4/safeZoom&&d<radius){
          const falloff=1-d/radius;
          // Match the approved preview's 120px field and 30px push. Holding
          // a click is handled separately; hover must not cancel the spring.
          const strength=30*density/safeZoom*falloff*falloff;
          x+=dx/d*strength;y+=dy/d*strength;
        }
      }
      targets[id]={x,y};
    }
    let speed=0,force=0;
    for(let step=0;step<steps;step++){
      const acceleration:Record<string,{x:number;y:number}>={};
      speed=0;force=0;
      for(const id of this.ids){
        const s=this.offsets[id],t=targets[id],adj=this.neighbors[id];
        let ax=(t.x-s.x)*105-s.vx*14,ay=(t.y-s.y)*105-s.vy*14;
        // Only existing direct neighbors share a small part of the displacement.
        for(const other of adj){const n=this.offsets[other];if(n){ax+=(n.x-s.x)*34/Math.max(1,adj.length);ay+=(n.y-s.y)*34/Math.max(1,adj.length);}}
        acceleration[id]={x:ax,y:ay};
      }
      for(const id of this.ids){
        const s=this.offsets[id],a=acceleration[id];
        if(id===selected){s.x=s.y=s.vx=s.vy=0;continue;}
        // Stabilize only a pressed target. A passing pointer keeps the
        // velocity and elastic response shown in the approved preview.
        if(id===held){s.vx=s.vy=0;continue;}
        s.vx+=a.x*h;s.vy+=a.y*h;s.x+=s.vx*h;s.y+=s.vy*h;
        const length=Math.hypot(s.x,s.y),bound=Math.min(limit,this.clearance[id]??Infinity);
        if(length>bound){s.x*=bound/length;s.y*=bound/length;s.vx*=.5;s.vy*=.5;}
        speed=Math.max(speed,Math.hypot(s.vx,s.vy)*zoom);force=Math.max(force,Math.hypot(a.x,a.y)*zoom);
      }
    }
    const moving=speed>.12||force>.65;
    if(!moving&&!pointer.active&&!ambient)this.reset();
    return moving||ambient;
  }
}
