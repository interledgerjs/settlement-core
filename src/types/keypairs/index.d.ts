declare module 'keypairs' {
    export interface Keypair {
      privateKey: string
      publicKey: string
    }
  
    export const deriveKeypair: (
      seed: string,
      options?: {
        entropy: string
      }
    ) => Keypair
  
    export const deriveAddress: (publicKey: string) => string
  }
  