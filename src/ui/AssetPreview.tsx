import { useEffect, useState } from 'react';
import type { AppError, WorkspaceRef } from '../contracts';
import { request, normalizeError } from '../api';
import { useI18n } from './i18n';
export function AssetPreview({workspace,path,onError}:{workspace:WorkspaceRef;path:string;onError:(error:AppError)=>void}){
  const {t}=useI18n();const [image,setImage]=useState<{url:string;byteLength:number;mime:string}|null>(null),[metadata,setMetadata]=useState<{byteLength:number;kind:string}|null>(null),[error,setError]=useState<AppError|null>(null);
  useEffect(()=>{let active=true;setImage(null);setError(null);void request<{byteLength:number;kind:string}>('file_metadata',workspace,{path}).then(value=>{if(active)setMetadata(value);}).catch(onError);
    if(/\.(png|jpe?g|webp|svg)$/i.test(path))void request<{url:string;byteLength:number;mime:string}>('image_metadata',workspace,{path}).then(value=>{if(active)setImage(value);}).catch(error=>{if(active)setError(normalizeError(error));});
    return()=>{active=false;};
  },[workspace,path,onError]);
  return image?<div className="image-preview" aria-label={t('이미지 미리 보기')}><img src={image.url} alt={path}/></div>:<div className="binary-preview"><h2>{path}</h2><p>{t('원본 파일을 안전하게 미리 볼 수 없습니다.')}</p>{metadata&&<p>{metadata.byteLength.toLocaleString()} {t('바이트')} · {metadata.kind}</p>}{error&&<p role="alert">{error.code}: {error.message}</p>}<div className="button-row"><button onClick={()=>void request('export_file',workspace,{path}).catch(onError)}>{t('복사본 저장')}</button><button onClick={()=>void request('open_external',workspace,{path}).catch(onError)}>{t('외부에서 열기')}</button></div></div>;
}
