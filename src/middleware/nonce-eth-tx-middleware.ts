import debug from 'debug'
import { NonceTx } from '../proto/loom_pb'
import { ITxMiddlewareHandler, Client, ITxResults } from '../client'
import { bytesToHex } from '../crypto-utils'

const log = debug('nonce-eth-tx-middleware')

export const INVALID_TX_NONCE_ERROR = 'Invalid tx nonce'

export function isInvalidTxNonceError(err: any): boolean {
  return err instanceof Error && err.message === INVALID_TX_NONCE_ERROR
}

/**
 * Wraps data in a NonceTx.
 * This middleware obtains the latest nonce from the chain for each tx.
 * The Loom DAppChain keeps track of the nonce of the last committed tx to prevent replay attacks.
 */
export class NonceEthTxMiddleware implements ITxMiddlewareHandler {
  private _fromAddress: string
  private _client: Client

  constructor(fromAddress: string, client: Client) {
    this._fromAddress = fromAddress
    this._client = client
  }

  async Handle(txData: Readonly<Uint8Array>): Promise<Uint8Array> {
    const nonce = await this._client.getNonce2Async('eth', this._fromAddress)

    log(`Next nonce ${nonce + 1}`)

    const tx = new NonceTx()
    tx.setInner(txData as Uint8Array)
    tx.setSequence(nonce + 1)
    return tx.serializeBinary()
  }

  HandleResults(results: ITxResults): ITxResults {
    const { validation, commit } = results
    if (
      validation &&
      validation.code === 1 &&
      (validation.log && validation.log.indexOf('sequence number does not match') !== -1)
    ) {
      throw new Error(INVALID_TX_NONCE_ERROR)
    }
    if (
      commit &&
      commit.code === 1 &&
      (commit.log && commit.log.indexOf('sequence number does not match') !== -1)
    ) {
      throw new Error(INVALID_TX_NONCE_ERROR)
    }
    return results
  }
}
