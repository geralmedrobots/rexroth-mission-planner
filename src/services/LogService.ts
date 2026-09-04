import type { AppLog } from '../domain/types';

type Listener = (entry: AppLog) => void;
class LogServiceImpl {
  private listeners = new Set<Listener>();
  public subscribe(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  public write(category: AppLog['category'], level: AppLog['level'], message: string): void {
    const entry: AppLog = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), category, level, message };
    this.listeners.forEach((listener) => listener(entry));
  }
}
export const LogService = new LogServiceImpl();
