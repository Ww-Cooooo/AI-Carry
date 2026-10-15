import {useEffect,useRef,useState} from 'react';
import {Checkbox,Dialog} from 'radix-ui';
import {Check,Minus,Trash2,Undo2,X,ArrowRight} from 'lucide-react';
import type {Asset} from './client-state';
import {SourceText} from './SourceText';
import {Help,Reveal,type Ask} from './shared';
import {assetCollections,buildAssetBatchRequest} from './asset-management.mjs';
import './memory-management.css';

export function AssetCheck({checked,label,onChange}:{checked:boolean|'indeterminate';label:string;onChange:()=>void}){
  return <Checkbox.Root className="memory-check" checked={checked} aria-label={label} onCheckedChange={onChange}>
    <Checkbox.Indicator>{checked==='indeterminate'?<Minus size={16}/>:<Check size={16}/>}</Checkbox.Indicator>
  </Checkbox.Root>;
}

type Props={collection:keyof typeof assetCollections;removed:boolean;removedCount:number;batch:boolean;visible:Asset[];selected:Asset[];onRemoved:(value:boolean)=>void;onBatch:(value:boolean)=>void;onToggle:(id:string)=>void;onToggleVisible:()=>void;onClear:()=>void;ask:Ask};
export default function AssetBatchTools({collection,removed,removedCount,batch,visible,selected,onRemoved,onBatch,onToggle,onToggleVisible,onClear,ask}:Props){
  const {label}=assetCollections[collection];
  const [review,setReview]=useState(false),[error,setError]=useState('');
  const reviewButton=useRef<HTMLButtonElement>(null);
  const checked=new Set(selected.map(item=>item.id)),visibleSelected=visible.filter(item=>checked.has(item.id)).length;
  const hiddenSelected=selected.length-visibleSelected;
  useEffect(()=>{if(!batch)setReview(false);},[batch]);
  const prepare=()=>{
    try{const request=buildAssetBatchRequest(selected,collection,removed?'restore':'remove');setError('');setReview(false);ask(request);}
    catch(e){setError((e as Error).message);}
  };
  return <>
    <div className="memory-tools">
      <div className="memory-view-actions"><button className="text-button" aria-pressed={removed} onClick={()=>onRemoved(!removed)}>{removed?<Undo2 size={17}/>:<Trash2 size={17}/>}{removed?`返回${label}`:'已移除'}{!removed&&<span className="memory-small-count">{removedCount}</span>}</button>
      <Help label={removed?'恢复后会怎样？':'删除后还能找回吗？'}>{removed?'Agent 会恢复移除前的状态。原本暂停或待复核的内容不会被直接启用。':'Agent 会保留原内容，停止日常调用，并把它放到当前分类的“已移除”中。需要永久擦除时，请另外向 Agent 说明。'}</Help></div>
      {!batch?<button className={`secondary-button memory-manage ${removed?'':'asset-delete-button'}`} disabled={!visible.length} onClick={()=>onBatch(true)}>{removed?<Undo2 size={17}/>:<Trash2 size={17}/>}{removed?'批量恢复':'批量删除'}</button>:<button className="text-button" onClick={()=>onBatch(false)}>退出多选<X size={16}/></button>}
    </div>
    {removed&&!batch&&<p className="memory-removed-note">这里只显示本分类已移除的内容，不参与日常调用。选中后可让 Agent 恢复。</p>}
    {batch&&<Reveal kind="selection" className="memory-batch-bar"><div className="memory-batch-selection">
      <label className="memory-select-visible"><AssetCheck checked={visible.length&&visibleSelected===visible.length?true:visibleSelected?'indeterminate':false} label="全选当前结果" onChange={onToggleVisible}/><span>全选当前结果</span></label>
      <span className="memory-selection-count" role="status">已选 <strong>{selected.length}</strong> 条{hiddenSelected>0&&<small>含筛选外 {hiddenSelected} 条</small>}</span>
      {selected.length>0&&<button className="text-button" onClick={onClear}>清空选择</button>}
      <button ref={reviewButton} className={`primary-button ${removed?'':'asset-delete-button'}`} disabled={!selected.length} onClick={()=>setReview(true)}>{removed?'恢复所选':'删除所选'}{removed?<Undo2 size={17}/>:<Trash2 size={17}/>}</button>
    </div><p>下一步先核对内容，复制请求给 Agent 后才会执行。</p></Reveal>}
    <Dialog.Root open={review} onOpenChange={setReview}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="request-dialog memory-review" data-lenis-prevent onCloseAutoFocus={event=>{event.preventDefault();reviewButton.current?.focus();}}>
      <Dialog.Close className="dialog-close" aria-label="关闭核对"><X size={20}/></Dialog.Close>
      <Dialog.Title>{`核对要${removed?'恢复':'删除'}的${label}`}</Dialog.Title>
      <Dialog.Description>{removed?'只恢复下面的内容，其他积累不变。':'只移除下面的内容，关联积累和原始资料不会连带删除。'}</Dialog.Description>
      <ul className="memory-review-list">{selected.map(item=><li key={item.id}><div><strong><SourceText>{item.title}</SourceText></strong><p><SourceText>{item.summary}</SourceText></p><small><SourceText>{item.id}</SourceText></small></div><button className="memory-unselect" aria-label={`取消选择：${item.title}`} title="取消选择" onClick={()=>onToggle(item.id)}><X size={18}/></button></li>)}</ul>
      {!selected.length&&<p>没有选中的内容。返回列表后可重新选择。</p>}
      {error&&<p role="alert">{error}</p>}
      <p className="memory-review-hint">{removed?'下一步预览完整请求，再复制给 Agent。':'可以从“已移除”找回；这不是永久擦除。下一步先预览请求。'}</p>
      <div className="memory-review-actions"><Dialog.Close className="secondary-button">返回选择</Dialog.Close><button className={`primary-button ${removed?'':'asset-delete-button'}`} disabled={!selected.length} onClick={prepare}>{removed?'生成恢复请求':'生成删除请求'}<ArrowRight size={17}/></button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
