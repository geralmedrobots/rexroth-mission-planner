import type { DiagnosticEvent, DiagnosticSink } from './DiagnosticEvent';

export class DiagnosticService implements DiagnosticSink {
  private readonly sinks = new Set<DiagnosticSink>();
  public addSink(sink: DiagnosticSink): () => void { this.sinks.add(sink); return () => this.sinks.delete(sink); }
  public emit(event: DiagnosticEvent): void { this.sinks.forEach((sink) => sink.emit(event)); }
}
