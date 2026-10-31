/**
 * A card can change after its toast appeared: the prover's result turns a
 * Warning into Proven. A toast keeps the card it was made with, so this
 * remembers what became of each card, and a late click on "Show me" opens the
 * newest version of that same card, never another commit's. No editor API
 * here, so it can be tested directly.
 */
import type { Card } from '../../src/engine/card';

export class CardVersions {
  private readonly next = new WeakMap<Card, Card>();

  replace(old: Card, updated: Card): void {
    this.next.set(old, updated);
  }

  latest(card: Card): Card {
    let current = card;
    for (let later = this.next.get(current); later; later = this.next.get(current)) current = later;
    return current;
  }
}
