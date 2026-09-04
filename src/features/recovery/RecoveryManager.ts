import type { RecoveryRuntime, RecoveryState } from './types';

const transitions:Record<RecoveryState,RecoveryState[]>={
  IDLE:['BLOCKED_CONFIRMED','FAILED'],
  BLOCKED_CONFIRMED:['CHECK_TURN_SPACE','FAILED'],
  CHECK_TURN_SPACE:['CHECK_REVERSE_SPACE','GLOBAL_REPLAN','FAILED'],
  CHECK_REVERSE_SPACE:['BUILD_REVERSE_ORDER','FAILED'],
  BUILD_REVERSE_ORDER:['SEND_REVERSE_ORDER','FAILED'],
  SEND_REVERSE_ORDER:['WAIT_REVERSE_ACCEPTANCE','FAILED'],
  WAIT_REVERSE_ACCEPTANCE:['REVERSING','FAILED'],
  REVERSING:['REVERSE_COMPLETED','FAILED'],
  REVERSE_COMPLETED:['GLOBAL_REPLAN','FAILED'],
  GLOBAL_REPLAN:['IDLE','FAILED'],
  FAILED:['IDLE','BLOCKED_CONFIRMED'],
};

export class RecoveryManager {
  private current:RecoveryState='IDLE';

  public get state():RecoveryState{return this.current;}

  public reset():void{this.current='IDLE';}

  public transition(next:RecoveryState):RecoveryState{
    if(!transitions[this.current].includes(next))
      throw new Error(`Invalid recovery transition ${this.current} -> ${next}.`);
    this.current=next;
    return this.current;
  }

  public snapshot(patch:Partial<RecoveryRuntime>={}):RecoveryRuntime{
    return {
      state:this.current,forwardBlocked:this.current!=='IDLE',
      rearObstacleCount:0,reversePath:[],...patch,
    };
  }
}
