export type Listener = () => void;

export function createListenerRegistry() {
  const listeners = new Set<Listener>();

  return {
    notify() {
      for (const listener of listeners) listener();
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
