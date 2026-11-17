/** Automatic builds wait for typing to stop; explicit builds use a separate lane. */
export class AutomaticBuild {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private pending=false;
  private editedAt=0;
  constructor(private run:()=>void,private busy:()=>boolean,private idleMs:()=>number){}
  changed(){
    this.editedAt=Date.now();
    if(this.pending)this.arm();
  }
  saved(){this.pending=true;this.arm();}
  settled(){if(this.pending)this.arm();}
  cancel(){clearTimeout(this.timer);this.timer=undefined;this.pending=false;}
  private arm(){
    clearTimeout(this.timer);
    this.timer=setTimeout(()=>{
      this.timer=undefined;
      if(!this.pending||this.busy())return;
      this.pending=false;this.run();
    },Math.max(0,this.editedAt+this.idleMs()-Date.now()));
  }
}
