import type { VdaOrder } from '../../domain/types';

export interface RouteRevisionSnapshot {
  readonly routeRevision: number;
  readonly plannedRouteRevision?: number;
  readonly generatedOrderRouteRevision?: number;
  readonly generatedOrder?: VdaOrder;
}

/** The sole identity check used before an Order can cross the publish boundary. */
export const isCurrentRouteOrder = (
  state: RouteRevisionSnapshot,
  order: VdaOrder,
  revision: number | undefined,
): boolean => revision!==undefined&&state.routeRevision===revision&&
  state.plannedRouteRevision===revision&&state.generatedOrderRouteRevision===revision&&
  state.generatedOrder?.orderId===order.orderId;

/** Prevents an older async destination workflow from changing the newer workflow's UI phase. */
export class RoutePreparationGuard {
  private token=0;
  public begin():number{return ++this.token;}
  public cancel():void{this.token+=1;}
  public isCurrent(token:number):boolean{return token===this.token;}
}
