import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRef } from '../contracts';

const files:Record<string,string>={};
vi.mock('../api',()=>({native:vi.fn(),request:vi.fn(async(_command:string,_workspace:WorkspaceRef,args:{path:string})=>{
  if(!(args.path in files))throw new Error(`missing ${args.path}`);
  return {text:files[args.path]};
})}));
const { findRoot } = await import('./workspace');

const workspace:WorkspaceRef={id:'w',environmentId:'ssh:host',root:'/home/me/project',epoch:1};
const entries=()=>Object.keys(files);
beforeEach(()=>{for(const key of Object.keys(files))delete files[key];});

describe('Overleaf-like main document resolution',()=>{
  it('compiles the opened document when it declares a class and nothing was chosen',async()=>{
    files['paper/TR-C/main.tex']='%% header\n\\documentclass[a4paper,fleqn]{cas-sc}\n\\begin{document}x\\end{document}';
    expect(await findRoot(workspace,'paper/TR-C/main.tex',null,false,entries(),files['paper/TR-C/main.tex'])).toBe('paper/TR-C/main.tex');
  });
  it('resolves a chapter to the single main document in the nearest enclosing folder',async()=>{
    files['paper/TR-C/main.tex']='\\documentclass{article}';files['paper/TR-C/preamble.tex']='\\usepackage{amsmath}';
    files['paper/TR-C/01_Intro/intro.tex']='\\section{Intro}';files['other/main.tex']='\\documentclass{report}';
    expect(await findRoot(workspace,'paper/TR-C/01_Intro/intro.tex',null,false,entries())).toBe('paper/TR-C/main.tex');
  });
  it('keeps an explicit choice when another standalone document is opened, but honors a root directive',async()=>{
    files['a/main.tex']='\\documentclass{article}';files['b/main.tex']='\\documentclass{article}';files['b/ch.tex']='% !TeX root = main.tex\n\\section{B}';
    expect(await findRoot(workspace,'b/main.tex','a/main.tex',true,entries())).toBe('a/main.tex');
    expect(await findRoot(workspace,'b/ch.tex','a/main.tex',true,entries())).toBe('b/main.tex');
  });
  it('refuses to guess between several documents at the same level',async()=>{
    files['paper.tex']='\\documentclass{article}';files['slides.tex']='\\documentclass{beamer}';files['notes/n.tex']='text';
    expect(await findRoot(workspace,'notes/n.tex',null,false,entries())).toBeNull();
  });
  it('ignores a commented-out document class',async()=>{
    files['draft.tex']='% \\documentclass{article}\nbody';
    expect(await findRoot(workspace,'draft.tex',null,false,entries(),files['draft.tex'])).toBeNull();
  });
});
