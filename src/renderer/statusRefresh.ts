export interface StatusRefreshTicket {
  sequence: number
  statusRevision: number
}

/**
 * Prevents a slow multi-resource refresh from overwriting a newer pushed
 * operation status. The main process remains the authority for live state;
 * refresh responses are accepted only when no newer status event arrived.
 */
export class StatusRefreshGuard {
  private sequence = 0
  private statusRevision = 0

  begin(): StatusRefreshTicket {
    return { sequence: ++this.sequence, statusRevision: this.statusRevision }
  }

  observeStatus(): void {
    this.statusRevision++
  }

  acceptsResources(ticket: StatusRefreshTicket): boolean {
    return ticket.sequence === this.sequence
  }

  acceptsStatus(ticket: StatusRefreshTicket): boolean {
    return this.acceptsResources(ticket) && ticket.statusRevision === this.statusRevision
  }
}
