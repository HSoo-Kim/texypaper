import { useCallback, useEffect, useRef, useState } from 'react';
import { native, normalizeError } from '../api';
import { useI18n } from './i18n';
import type { AppSettings } from './theme';
export type UpdateStatus={kind:'unconfigured'|'disabled'|'idle'|'current'|'available'|'error';currentVersion:string;latestVersion?:string;releaseUrl?:string;notes?:string;checkedAt?:number;error?:string};
export type UpdateController={status:UpdateStatus|null;available:UpdateStatus|null;busy:boolean;check:(force?:boolean)=>Promise<void>;};
export function useUpdates(settings:AppSettings['updates']):UpdateController{
  const [status,setStatus]=useState<UpdateStatus|null>(null),[available,setAvailable]=useState<UpdateStatus|null>(null),[busy,setBusy]=useState(false);const checking=useRef(false),sequence=useRef(0);
  const receive=useCallback((value:UpdateStatus)=>{setStatus(value);if(value.kind==='available')setAvailable(value);else if(value.kind==='current')setAvailable(null);},[]);
  const check=useCallback(async(force=false)=>{if(checking.current)return;checking.current=true;setBusy(true);const requestId=++sequence.current;try{const value=await native<UpdateStatus>('update_check',{force});if(requestId===sequence.current)receive(value);}catch(error){setStatus(previous=>({kind:'error',currentVersion:previous?.currentVersion??'',error:normalizeError(error).message}));}finally{checking.current=false;setBusy(false);}},[receive]);
  useEffect(()=>{let active=true;const requestId=++sequence.current;void native<UpdateStatus>('update_status').then(value=>{if(active&&requestId===sequence.current)receive(value);}).catch(()=>{});return()=>{active=false;};},[receive]);
  useEffect(()=>{if(settings?.enabled===false)return;void check(false);const interval=window.setInterval(()=>void check(false),24*60*60*1000);return()=>clearInterval(interval);},[settings?.enabled,settings?.feedUrl,check]);
  return {status,available,busy,check};
}
export function UpdateNotice({updates,onConfigure}:{updates:UpdateController;onConfigure:()=>void}){
  const {t}=useI18n();const release=updates.available;const [openError,setOpenError]=useState<string|null>(null);
  if(release)return <div className="update-notice" data-testid="update-notice" role="status">
    <span className="update-message">{t('새 버전이 있습니다.','A new version is available.')} <strong>TexyPaper {release.latestVersion}</strong></span>
    <button data-testid="update-open" disabled={!release.releaseUrl} onClick={()=>{if(!release.releaseUrl)return;setOpenError(null);void native('open_external_url',{url:release.releaseUrl}).catch(error=>setOpenError(normalizeError(error).message));}}>{t('릴리스 확인','View release')}</button>
    <button onClick={onConfigure}>{t('업데이트 설정','Update settings')}</button>
    {openError&&<span role="alert">{t('릴리스 페이지를 열 수 없습니다.','Could not open the release page.')} {openError}</span>}
    {updates.status?.error&&<span className="muted">{t('최근 확인은 실패했지만 확인된 새 버전 알림은 유지합니다.','The latest check failed; the confirmed release is still shown.')}</span>}
  </div>;
  if(updates.status?.kind==='unconfigured')return <div className="update-unconfigured">
    <span className="update-message">{t('업데이트 릴리스 주소가 아직 설정되지 않았습니다.','No release feed is configured yet.')}</span>
    <button data-testid="update-configure" onClick={onConfigure}>{t('업데이트 알림 설정','Configure update notifications')}</button>
  </div>;
  return null;
}
export function UpdateSettings({settings,onChange,updates}:{settings:AppSettings;onChange:(patch:Partial<AppSettings>)=>void;updates:UpdateController}){
  const {t}=useI18n();const [feed,setFeed]=useState(settings.updates?.feedUrl??''),[validation,setValidation]=useState('');useEffect(()=>setFeed(settings.updates?.feedUrl??''),[settings.updates?.feedUrl]);
  const enabled=settings.updates?.enabled!==false,status=updates.status;
  const save=()=>{try{if(feed.trim()){const url=new URL(feed.trim());if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error();}setValidation('');onChange({updates:{enabled,feedUrl:feed.trim()}});}catch{setValidation(t('사용자 정보·쿼리·조각이 없는 HTTPS 주소를 입력하세요.','Enter an HTTPS URL without credentials, query parameters, or a fragment.'));}};
  return <section className="update-settings"><h2>{t('업데이트 알림','Update notifications')}</h2><label className="check"><input data-testid="updates-enabled" type="checkbox" checked={enabled} onChange={event=>onChange({updates:{enabled:event.target.checked,feedUrl:settings.updates?.feedUrl??''}})}/>{t('새 버전이 있으면 하단에 계속 알림 표시','Keep a bottom notification when a new release is available')}</label><label>{t('릴리스 피드 또는 GitHub 저장소','Release feed or GitHub repository')}<input data-testid="updates-feed" type="url" value={feed} onChange={event=>setFeed(event.target.value)} placeholder="https://github.com/HSoo-Kim/texypaper" spellCheck={false}/></label><p className="muted">{t('실제 배포 저장소나 HTTPS latest.json 주소가 필요합니다. 업데이트를 자동 설치하거나 설치 파일을 실행하지 않습니다.','A real release repository or HTTPS latest.json URL is required. Updates are never installed or executed automatically.')}</p>{validation&&<p className="palette-error" role="alert">{validation}</p>}<div className="button-row"><button data-testid="updates-feed-save" onClick={save}>{t('주소 저장','Save feed')}</button><button data-testid="update-check" disabled={updates.busy||!enabled} onClick={()=>void updates.check(true)}>{updates.busy?t('확인 중…','Checking…'):t('지금 확인','Check now')}</button></div><p data-testid="update-status" role="status">{status?.kind==='available'?t(`새 버전 ${status.latestVersion}`,`New release ${status.latestVersion}`):status?.kind==='current'?t('최신 버전입니다.','You are up to date.'):status?.kind==='disabled'?t('업데이트 확인이 꺼져 있습니다.','Update checks are disabled.'):status?.kind==='unconfigured'?t('릴리스 주소를 먼저 설정하세요.','Configure a release feed first.'):status?.kind==='idle'?t('릴리스 주소가 설정되었습니다. 지금 확인할 수 있습니다.','The feed is configured. You can check now.'):status?.kind==='error'?t('업데이트를 확인할 수 없습니다. 네트워크와 릴리스 주소를 확인하세요.','Could not check for updates. Check your network and release feed.'):t('업데이트 상태를 불러오는 중…','Loading update status…')}</p>{status?.currentVersion&&<p className="muted">{t('현재 버전','Current version')}: {status.currentVersion}</p>}{status?.checkedAt&&<p className="muted">{t('마지막 확인','Last checked')}: {new Date(status.checkedAt*1000).toLocaleString()}</p>}{status?.notes&&<details><summary>{t('릴리스 노트','Release notes')}</summary><p className="release-notes">{status.notes}</p></details>}{status?.error&&<details><summary>{t('확인 오류 상세','Check error details')}</summary><pre className="release-notes">{status.error}</pre></details>}</section>;
}
