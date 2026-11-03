// Link to an existing content owner; record markers never expose raw sources.
export function contentLocation(node) {
  if (!node?.entry || !node.assetId) return null;
  if (['memory','sop','capability','experience'].includes(node.kind)) {
    return 'library?' + new URLSearchParams({view:'list',kind:node.area,item:node.assetId});
  }
  if (node.kind === 'learning') return 'growth?' + new URLSearchParams({tab:'learning',item:node.assetId,from:node.id});
  if (node.kind === 'skill') return 'workshop?' + new URLSearchParams({tab:'mine',kind:node.area==='exports'?'own':'installed',item:node.assetId,from:node.id});
  return null;
}
export function mapLocation(id) {
  return '#library?' + new URLSearchParams({view:'map',node:id});
}
