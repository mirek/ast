const freezeChildren = (value: object): void => {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
};

export const deepFreeze = <T extends object>(value: T): T => {
  freezeChildren(value);
  return Object.freeze(value);
};

export const immutableCopy = <T extends object>(value: T): T =>
  deepFreeze(structuredClone(value));
