import {Archive,Brain,BriefcaseBusiness,ClipboardCheck,FileStack,Lightbulb,Link2,ListChecks,Network,Palette,Puzzle,Route,ScanSearch,ShieldCheck,Sprout,Video,WandSparkles} from 'lucide-react';
import type {AccumulationNode} from './AccumulationScene';
import {localizeText} from '../lib/i18n';

const icons={memory:Brain,sop:ListChecks,capability:WandSparkles,experience:Lightbulb,learning:Sprout,skill:Puzzle,task:BriefcaseBusiness,source:FileStack};
// A display excerpt, never a rewritten record. Full names remain in search,
// accessible names, native hover titles and the inspector.
const labelCache=new WeakMap<AccumulationNode[],Map<string,string>>();
const units=(text:string)=>Array.from(text).reduce((n,c)=>n+(/[^\u0000-\u00ff]/u.test(c)?2:1),0);
function take(text:string,budget:number,tail=false){const chars=Array.from(text);if(tail)chars.reverse();let used=0;const result=[];for(const c of chars){used+=units(c);if(used>budget)break;result.push(c);}return (tail?result.reverse():result).join('');}
function excerpt(text:string,budget=20){return units(text)<=budget?text:take(text,Math.floor(budget*.48)).trimEnd()+'…'+take(text,Math.floor(budget*.48),true).trimStart();}
function labelsFor(nodes:AccumulationNode[]){
  const cached=labelCache.get(nodes);if(cached)return cached;
  const headings=new Map<string,number>();
  for(const n of nodes){const match=n.title.trim().match(/^(.{2,})[：:]\s*(.+)$/u);if(match)headings.set(match[1],(headings.get(match[1])||0)+1);}
  const labels=new Map<string,string>(),collisions=new Map<string,AccumulationNode[]>();
  for(const n of nodes){
    const title=n.title.trim(),match=title.match(/^(.{2,})[：:]\s*(.+)$/u);
    // A shared heading is redundant on the map. Keep the distinguishing part
    // verbatim; the complete original is still in the inspector and search.
    const label=excerpt(match&&(headings.get(match[1])||0)>1?match[2]:title);
    labels.set(n.id,label);const group=collisions.get(label)||[];group.push(n);collisions.set(label,group);
  }
  for(const group of collisions.values())if(group.length>1){
    let prefix=Array.from(group[0].title.trim());
    for(const n of group.slice(1)){const chars=Array.from(n.title.trim());let i=0;while(i<prefix.length&&prefix[i]===chars[i])i++;prefix=prefix.slice(0,i);}
    const used=new Set<string>();
    for(const [i,n]of [...group].sort((a,b)=>a.id.localeCompare(b.id)).entries()){
      const rest=Array.from(n.title.trim()).slice(prefix.length).join('').trim();
      let label=rest?'…'+excerpt(rest,18):labels.get(n.id)!;
      if(used.has(label))label=excerpt(label,15)+' · '+(i+1);
      used.add(label);labels.set(n.id,label);
    }
  }
  labelCache.set(nodes,labels);return labels;
}
export function presentation(node:AccumulationNode,peers?:AccumulationNode[]){
  const title=node.title.trim();
  if(node.kind==='task'||node.kind==='source')return {label:`${localizeText(node.kind==='task'?'任务':'来源')} ${node.id.split(':').at(-1)?.padStart(2,'0')}`,icon:icons[node.kind]};
  const label=peers?labelsFor(peers).get(node.id)||excerpt(title):excerpt(title);
  // Symbols describe the visible subject only; they do not create relations.
  const icon=/视频|video/i.test(title)?Video:/界面|设计|配色|design|style/i.test(title)?Palette:
    /来源|追溯|source|trace/i.test(title)?ScanSearch:/检查|校验|验证|check|validat/i.test(title)?ShieldCheck:
    /回执|receipt/i.test(title)?ClipboardCheck:/归档|材料|archive/i.test(title)?Archive:
    /关系|关联|graph|relation/i.test(title)?Network:/交接|流程|handoff|workflow/i.test(title)?Route:
    /链接|引用|link|reference/i.test(title)?Link2:icons[node.kind as keyof typeof icons]||Lightbulb;
  return {label,icon};
}
