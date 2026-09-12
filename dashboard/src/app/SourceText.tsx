import {createElement,type ReactNode} from 'react';

// User-authored material is data, not interface copy for automatic translation.
export const SourceText=Object.assign(function SourceText({children}:{children:ReactNode}){
  return createElement('span',{lang:'',translate:'no'},children);
},{aiCarrySourceText:true});
