export const hash = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");

export const normaliserEmail = (email: string) => email.trim().toLowerCase();

export const emailValide = (email: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
