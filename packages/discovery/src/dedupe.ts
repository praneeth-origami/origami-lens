export class UrlQueue {
  private seen = new Set<string>();
  private queue: string[] = [];

  constructor(initial: string[] = []) {
    for (const url of initial) {
      this.add(url);
    }
  }

  add(url: string): boolean {
    if (this.seen.has(url)) return false;
    this.seen.add(url);
    this.queue.push(url);
    return true;
  }

  addMany(urls: string[]): number {
    let added = 0;
    for (const url of urls) {
      if (this.add(url)) added++;
    }
    return added;
  }

  next(): string | undefined {
    return this.queue.shift();
  }

  get size(): number {
    return this.seen.size;
  }

  get pending(): number {
    return this.queue.length;
  }

  toArray(): string[] {
    return [...this.seen];
  }
}
