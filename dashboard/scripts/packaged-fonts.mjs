import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
// Shared distribution check. Font licensing is distinct from the project's license.
export async function checkPackagedFonts(directory,manifest,html){
  if(manifest.schemaVersion!==1||!manifest.fonts?.length)throw Error('Packaged font inventory is missing');
  const paths=[];const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  for(const font of manifest.fonts){
    if(font.licenseSpdx!=='LicenseRef-MiSans'||font.family!=='MiSans'||!font.unchangedUpstreamBytes||!font.source?.archiveSha256||!font.copyright)throw Error('Unreviewed packaged font: '+font.file);
    for(const [name,digest] of [[font.file,font.sha256],[font.licenseFile,font.licenseSha256]]){
      if(!/^[\w.-]+$/.test(name))throw Error('Font inventory path must stay within its directory');
      const bytes=await readFile(resolve(directory,name));if(!bytes.length||hash(bytes)!==digest)throw Error('Packaged font or license differs: '+name);paths.push(name);
    }
    if(html&&!html.includes('./fonts/'+font.file))throw Error('Packaged font not referenced by the page: '+font.file);
  }
  return [...new Set(paths)];
}
