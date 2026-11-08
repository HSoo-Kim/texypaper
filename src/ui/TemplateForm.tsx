import { useEffect, useState, type RefObject } from 'react';
import type { Environment } from '../contracts';
import { native, normalizeError } from '../api';
import { paperTemplates } from '../features/templates/templates';
import { TemplateCreationError } from '../features/templates/createFromTemplate';
import { errorText } from './errors';
import { t } from './i18n';
import '../features/templates/templates.css';

type Props = {
  environments: Environment[];
  environmentId: string;
  selected: Environment;
  busy: boolean;
  hidden: boolean;
  error: string;
  formId: string;
  helperConsent: boolean;
  opening: RefObject<boolean>;
  templateInput: RefObject<HTMLInputElement | null>;
  templateAction: RefObject<HTMLButtonElement | null>;
  setEnvironmentId: (value: string) => void;
  setHelperConsent: (value: boolean) => void;
  setTemplatePending: (value: boolean) => void;
  setError: (value: string) => void;
  closePanel: () => void;
  onCreateFromTemplate: (environment: Environment, root: string, templateId: string) => Promise<void>;
};

export function TemplateForm({ environments, environmentId, selected, busy, hidden, error, formId, helperConsent, opening, templateInput, templateAction, setEnvironmentId, setHelperConsent, setTemplatePending, setError, closePanel, onCreateFromTemplate }: Props) {
  const [templatePath,setTemplatePath]=useState(''),[templateId,setTemplateId]=useState(paperTemplates[0].id);
  // Loading must not steal focus if the user has moved away from the disclosure button.
  useEffect(() => {
    if (!hidden && (document.activeElement === templateAction.current || document.activeElement === document.body)) templateInput.current?.focus();
  }, [hidden, templateAction, templateInput]);
  const createTemplate=async()=>{
    if(busy||opening.current)return;
    setError('');
    if(!templatePath.trim()){setError(t('이미 있는 프로젝트 폴더 경로를 입력하세요.','Enter the path to an existing project folder.'));return;}
    if(selected.kind==='ssh'&&!helperConsent){setError(t('SSH 도움 프로그램 실행 안내에 동의해 주세요.','Accept the SSH helper notice before connecting.'));return;}
    opening.current=true;setTemplatePending(true);
    try{await onCreateFromTemplate(selected,templatePath.trim(),templateId);}
    catch(error){
      if(error instanceof TemplateCreationError&&error.code==='TEMPLATE_CONFLICT')setError(`${t('다음 경로가 이미 있어 파일을 만들지 않았습니다. 다른 폴더를 선택하세요.','These paths already exist; no template files were created. Choose another folder.')} ${error.paths.join(', ')}`);
      else if(error instanceof TemplateCreationError&&error.code==='TEMPLATE_CREATE_FAILED')setError(`${t('파일 생성을 중지했습니다. 실패한 경로:','Creation stopped. Failed path:')} ${error.failedPath}. ${t('이미 생성된 경로:','Already created:')} ${error.created.join(', ')||t('없음','none')}. ${t('생성된 파일은 그대로 두었습니다. 다시 시도하기 전에 폴더를 확인하세요.','Created files were kept. Check the folder before retrying.')}`);
      else setError(errorText(normalizeError(error)));
    }finally{opening.current=false;setTemplatePending(false);}
  };
  return (
      <form className="picker-form template-form" id={`${formId}-template`} aria-label={t('템플릿으로 새 논문','New paper from template')} aria-describedby={error?`${formId}-error`:undefined} hidden={hidden} onSubmit={event=>{event.preventDefault();void createTemplate();}}>
        <div className="dialog-heading"><div><h2>{t('템플릿으로 새 논문','New paper from template')}</h2><p className="muted">{t('이미 있는 폴더에 논문 파일을 만듭니다. 비어 있는 폴더를 권장합니다.','Create paper files in an existing folder. An empty folder is recommended.')}</p></div><button type="button" disabled={busy} aria-label={t('템플릿 입력 접기','Collapse template form')} onClick={closePanel}>{t('닫기')}</button></div>
        <label>{t('환경','Environment')}<select data-testid="template-environment" aria-label={t('템플릿 환경','Template environment')} value={environmentId} disabled={busy} onChange={event=>{setEnvironmentId(event.target.value);setHelperConsent(false);}}>{environments.map(environment=><option key={environment.id} value={environment.id}>{environment.kind==='local'&&environment.label==='이 컴퓨터'?t('이 컴퓨터','This computer'):environment.label}{environment.kind==='ssh'?' · SSH':''}</option>)}</select></label>
        <div className="field-row"><label className="grow">{t('프로젝트 폴더','Project folder')}<input ref={templateInput} data-testid="template-path" aria-label={t('템플릿 프로젝트 폴더','Template project folder')} aria-describedby={`${formId}-template-note${error?` ${formId}-error`:''}`} value={templatePath} disabled={busy} onChange={event=>setTemplatePath(event.target.value)} placeholder={t('이미 있는 폴더 경로 (빈 폴더 권장)','Existing folder path (may be empty)')}/></label>{selected.kind==='local'&&<button type="button" disabled={busy} onClick={()=>void native<string|null>('pick_folder').then(path=>{if(path)setTemplatePath(path);}).catch(error=>setError(errorText(normalizeError(error))))}>{t('폴더 선택','Browse folder')}</button>}</div>
        <fieldset className="template-choices" disabled={busy}><legend>{t('논문 템플릿','Paper template')}</legend>{paperTemplates.map(template=><label className="template-choice" key={template.id}><input type="radio" name={`${formId}-template-choice`} data-testid={`template-choice-${template.id}`} value={template.id} checked={templateId===template.id} onChange={()=>setTemplateId(template.id)}/><span><strong>{t(template.name.ko,template.name.en)}</strong><span className="muted">{t(template.description.ko,template.description.en)}</span></span></label>)}</fieldset>
        <p id={`${formId}-template-note`} className="muted template-safety-note">{t('파일을 새로 만들기만 하며 기존 파일은 절대 덮어쓰지 않습니다. 같은 이름의 파일이 이미 있으면 아무것도 만들지 않습니다.','Only new files are created; existing files are never overwritten. If a file with the same name already exists, nothing is created.')}</p>
        {selected.kind==='ssh'&&<label className="check ssh-helper-notice"><input data-testid="template-helper-consent" type="checkbox" disabled={busy} checked={helperConsent} onChange={event=>setHelperConsent(event.target.checked)}/>{t('선택한 서버에서 Python 3.9 이상이 필요합니다. TexyPaper가 SHA-256 검증된 작은 도움 프로그램을 ~/.cache/texypaper/worker/에 저장하고 연결 동안 실행합니다. 서버에 패키지를 설치하지 않습니다.','The selected server needs Python 3.9 or later. TexyPaper caches a small SHA-256-verified helper in ~/.cache/texypaper/worker/ and runs it during the connection. No packages are installed on the server.')}</label>}
        <div className="button-row"><button className="primary" data-testid="template-create" type="submit" disabled={busy}>{busy?t('만드는 중…','Creating…'):t('만들고 열기','Create and open')}</button>{busy&&<span role="status" className="muted">{t('연결하고 템플릿 파일을 만드는 중입니다.','Connecting and creating template files.')}</span>}</div>
      </form>
  );
}
