import {useCallback,useEffect,useRef,useState} from 'react';
import {workspaceEvents} from '../api';
import type {BuildManifest,WorkspaceRef} from '../contracts';
import type {BufferStore} from '../editor/buffers';
import type {ProjectSettings} from '../state/workspace';
import {LivePreview,type LivePreviewState} from './livePreview';

const empty:LivePreviewState={pdf:null,ready:false};
export function useLivePreview(workspace:WorkspaceRef|null,store:BufferStore|null,manifest:BuildManifest|null,project:ProjectSettings,visible:boolean,buildPhase:string) {
  const owner=useRef<LivePreview|null>(null),viewport=useRef(1),[state,setState]=useState<LivePreviewState&{scope?:string}>(empty);
  const setViewport=useCallback((page:number)=>{
    if(!Number.isSafeInteger(page)||page<1||page>10000)return;
    viewport.current=page;owner.current?.setViewport(page);
  },[]);
  const enabled=project.autoBuild&&project.profile==='basic';
  const scope=`${workspace?.id}:${workspace?.epoch}:${project.rootTex}:${project.engine}:${enabled}`;
  useEffect(()=>{
    setState(empty);
    if(!workspace||!store||!project.rootTex||!enabled)return;
    const controller=new LivePreview(workspace,store,project.rootTex,project.engine,next=>{if(owner.current===controller)setState({...next,scope});});
    owner.current=controller;
    controller.setViewport(viewport.current);
    const events=workspaceEvents(workspace,event=>{
      if(event.kind!=='workspace/changed'&&event.kind!=='file/changed')return;
      const payload=event.payload as {paths?:unknown};
      if(Array.isArray(payload?.paths))void controller.externalChanged(payload.paths.filter((path):path is string=>typeof path==='string'));
    });
    const canonical=(event:Event)=>controller.syncForward((event as CustomEvent<{buildId?:string}>).detail?.buildId),rejected=()=>controller.invalidate();
    window.addEventListener('texypaper:sync-forward',canonical);
    window.addEventListener('texypaper:live-preview-rejected',rejected);
    return()=>{if(owner.current===controller)owner.current=null;controller.dispose();void events.then(stop=>stop());window.removeEventListener('texypaper:sync-forward',canonical);window.removeEventListener('texypaper:live-preview-rejected',rejected);};
  },[workspace?.id,workspace?.epoch,store,project.rootTex,project.engine,enabled]);
  useEffect(()=>{owner.current?.setActive(visible);},[visible,workspace?.id,workspace?.epoch,store,project.rootTex,project.engine,enabled]);
  useEffect(()=>{if(manifest)void owner.current?.setManifest(manifest);},[manifest,workspace?.id,workspace?.epoch,store,project.rootTex,project.engine,enabled]);
  useEffect(()=>{if(['failed','cancelled','timeout'].includes(buildPhase))owner.current?.invalidate();},[buildPhase]);
  return {...(state.scope===scope?state:empty),setViewport};
}
