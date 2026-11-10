/* Bounded, ordered processing of CAPTURED source frames. No artificial dt cap.
 * Temporary backlog is drained in timestamp order. If history is too old, we
 * explicitly re-prime at the current sample and expose a resynchronisation.
 * That is missing input, not an attempt to recreate unseen intermediate images.
 */
export function chooseProcessingFrame(items,eligible,last,period=1/30){
  if(!eligible)return null;
  if(!last)return {anchor:eligible,resync:false,skipped:0,backlog:0};
  if(eligible.id<=last.id)return null;
  const maxBacklog=Math.max(.2,4*period);
  const next=items.find(f=>f.id>last.id&&f.id<=eligible.id);
  const backlog=Math.max(0,eligible.t-(next?.t??eligible.t));
  const gap=next?next.t-last.t:Infinity;
  const resync=!next||eligible.t-last.t>maxBacklog||gap>maxBacklog;
  const anchor=resync?eligible:next;
  return {anchor,resync,skipped:Math.max(0,anchor.id-last.id-1),backlog};
}
