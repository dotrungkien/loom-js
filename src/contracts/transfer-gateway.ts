import BN from 'bn.js'
import { Client } from '../client'
import { Contract } from '../contract'
import { Address } from '../address'
import {
  TransferGatewayWithdrawTokenRequest,
  TransferGatewayWithdrawETHRequest,
  TransferGatewayWithdrawalReceiptRequest,
  TransferGatewayWithdrawalReceiptResponse,
  TransferGatewayTokenKind,
  TransferGatewayAddContractMappingRequest,
  TransferGatewayTokenWithdrawalSigned,
  TransferGatewayContractMappingConfirmed,
  TransferGatewayReclaimContractTokensRequest,
  TransferGatewayReclaimDepositorTokensRequest
} from '../proto/transfer_gateway_pb'
import { marshalBigUIntPB, unmarshalBigUIntPB } from '../big-uint'
import { B64ToUint8Array } from '../crypto-utils'
import { utils } from 'ethers'

export interface IWithdrawalReceipt {
  tokenOwner: Address
  // Mainnet address of token contract
  tokenContract: Address
  tokenKind: TransferGatewayTokenKind
  // ERC721/X token ID
  tokenId?: BN
  // ERC721X/ERC20/ETH amount
  tokenAmount?: BN
  withdrawalNonce: BN

  // Deprecated, use tokenId and tokenAmount instead.
  // This is the ERC721 token ID, or ERC721X/ERC20/ETH amount.
  value: BN

  sigs: Array<utils.Signature>
}

export interface ITokenWithdrawalEventArgs {
  tokenOwner: Address
  // Mainnet address of token contract, blank if ETH
  tokenContract: Address
  tokenKind: TransferGatewayTokenKind
  // ERC721/X token ID
  tokenId?: BN
  // ERC721X/ERC20/ETH amount
  tokenAmount?: BN
  // Validator signatures
  sigs: Array<utils.Signature>

  // Deprecated, use tokenId and tokenAmount instead.
  // This is the ERC721 token ID, or ERC721X/ERC20/ETH amount.
  value: BN
}

export interface IContractMappingConfirmedEventArgs {
  // Address of a contract on a foreign blockchain
  foreignContract: Address
  // Address of corresponding contract on the local blockchain
  localContract: Address
}

export class TransferGateway extends Contract {
  // LoomJS user events
  static readonly EVENT_TOKEN_WITHDRAWAL = 'event_token_withdrawal'
  static readonly EVENT_CONTRACT_MAPPING_CONFIRMED = 'event_contract_mapping_confirmed'

  // Events from Loomchain
  static readonly tokenWithdrawalSignedEventTopic: String = 'event:TokenWithdrawalSigned'
  static readonly contractMappingConfirmedEventTopic: String = 'event:ContractMappingConfirmed'

  static async createAsync(client: Client, callerAddr: Address): Promise<TransferGateway> {
    const contractAddr = await client.getContractAddressAsync('gateway')
    if (!contractAddr) {
      throw Error('Failed to resolve contract address for TransferGateway')
    }

    return new TransferGateway({ contractAddr, callerAddr, client })
  }

  constructor(params: { contractAddr: Address; callerAddr: Address; client: Client }) {
    super(params)

    this.on(Contract.EVENT, event => {
      if (!event.topics || event.topics.length === 0) {
        return
      }

      if (event.topics[0] === TransferGateway.tokenWithdrawalSignedEventTopic) {
        const eventData = TransferGatewayTokenWithdrawalSigned.deserializeBinary(
          B64ToUint8Array(event.data)
        )

        let tokenId: BN | undefined
        let tokenAmount: BN | undefined
        let value: BN

        const tokenKind = eventData.getTokenKind()
        switch (tokenKind) {
          case TransferGatewayTokenKind.ERC721:
            tokenId = unmarshalBigUIntPB(eventData.getTokenId()!)
            value = tokenId
            break
          case TransferGatewayTokenKind.ERC721X:
            tokenId = unmarshalBigUIntPB(eventData.getTokenId()!)
          // fallthrough
          // tslint:disable-next-line: no-switch-case-fall-through
          default:
            tokenAmount = unmarshalBigUIntPB(eventData.getTokenAmount()!)
            value = tokenAmount
            break
        }

        this.emit(TransferGateway.EVENT_TOKEN_WITHDRAWAL, {
          tokenOwner: Address.UnmarshalPB(eventData.getTokenOwner()!),
          tokenContract: Address.UnmarshalPB(eventData.getTokenContract()!),
          tokenKind,
          tokenId,
          tokenAmount,
          sigs: eventData.getValidatorSignaturesList().map(utils.splitSignature),
          value
        } as ITokenWithdrawalEventArgs)
      } else if (event.topics[0] === TransferGateway.contractMappingConfirmedEventTopic) {
        const contractMappingConfirmed = TransferGatewayContractMappingConfirmed.deserializeBinary(
          B64ToUint8Array(event.data)
        )

        this.emit(TransferGateway.EVENT_CONTRACT_MAPPING_CONFIRMED, {
          foreignContract: Address.UnmarshalPB(contractMappingConfirmed.getForeignContract()!),
          localContract: Address.UnmarshalPB(contractMappingConfirmed.getLocalContract()!)
        } as IContractMappingConfirmedEventArgs)
      }
    })
  }

  /**
   * Adds a contract mapping to the DAppChain Gateway.
   * A contract mapping associates a token contract on the DAppChain with it's counterpart on Ethereum.
   */
  addContractMappingAsync(params: {
    foreignContract: Address
    localContract: Address
    foreignContractCreatorSig: Uint8Array
    foreignContractCreatorTxHash: Uint8Array
  }): Promise<void> {
    const {
      foreignContract,
      localContract,
      foreignContractCreatorSig,
      foreignContractCreatorTxHash
    } = params

    const mappingContractRequest = new TransferGatewayAddContractMappingRequest()
    mappingContractRequest.setForeignContract(foreignContract.MarshalPB())
    mappingContractRequest.setLocalContract(localContract.MarshalPB())
    mappingContractRequest.setForeignContractCreatorSig(foreignContractCreatorSig)
    mappingContractRequest.setForeignContractTxHash(foreignContractCreatorTxHash)

    return this.callAsync<void>('AddContractMapping', mappingContractRequest)
  }

  /**
   * Sends a request to the DAppChain Gateway to begin withdrawal of an ERC721 token from the
   * current DAppChain account to an Ethereum account.
   * @param tokenId ERC721 token ID.
   * @param tokenContract DAppChain address of ERC721 contract.
   * @param recipient Ethereum address of the account the token should be withdrawn to, if this is
   *                  omitted the Gateway will attempt to use the Address Mapper to retrieve the
   *                  address of the Ethereum account mapped to the current DAppChain account.
   * @returns A promise that will be resolved when the DAppChain Gateway has accepted the withdrawal
   *          request.
   */
  withdrawERC721Async(tokenId: BN, tokenContract: Address, recipient?: Address): Promise<void> {
    const req = new TransferGatewayWithdrawTokenRequest()
    req.setTokenKind(TransferGatewayTokenKind.ERC721)
    req.setTokenId(marshalBigUIntPB(tokenId))
    req.setTokenContract(tokenContract.MarshalPB())
    if (recipient) {
      req.setRecipient(recipient.MarshalPB())
    }

    return this.callAsync<void>('WithdrawToken', req)
  }

  /**
   * Sends a request to the DAppChain Gateway to begin withdrawal of ERC721X tokens from the current
   * DAppChain account to an Ethereum account.
   * @param tokenId ERC721X token ID.
   * @param amount Amount of tokenId to withdraw.
   * @param tokenContract DAppChain address of ERC721X contract.
   * @param recipient Ethereum address of the account the token should be withdrawn to, if this is
   *                  omitted the Gateway will attempt to use the Address Mapper to retrieve the
   *                  address of the Ethereum account mapped to the current DAppChain account.
   * @returns A promise that will be resolved when the DAppChain Gateway has accepted the withdrawal
   *          request.
   */
  withdrawERC721XAsync(
    tokenId: BN,
    amount: BN,
    tokenContract: Address,
    recipient?: Address
  ): Promise<void> {
    const req = new TransferGatewayWithdrawTokenRequest()
    req.setTokenKind(TransferGatewayTokenKind.ERC721X)
    req.setTokenId(marshalBigUIntPB(tokenId))
    req.setTokenAmount(marshalBigUIntPB(amount))
    req.setTokenContract(tokenContract.MarshalPB())
    if (recipient) {
      req.setRecipient(recipient.MarshalPB())
    }

    return this.callAsync<void>('WithdrawToken', req)
  }

  /**
   * Sends a request to the DAppChain Gateway to begin withdrawal ERC20 tokens from the current
   * DAppChain account to an Ethereum account.
   * @param amount Amount to withdraw.
   * @param tokenContract DAppChain address of ERC20 contract.
   * @param recipient Ethereum address of the account the token should be withdrawn to, if this is
   *                  omitted the Gateway will attempt to use the Address Mapper to retrieve the
   *                  address of the Ethereum account mapped to the current DAppChain account.
   * @returns A promise that will be resolved when the DAppChain Gateway has accepted the withdrawal
   *          request.
   */
  withdrawERC20Async(amount: BN, tokenContract: Address, recipient?: Address): Promise<void> {
    const req = new TransferGatewayWithdrawTokenRequest()
    req.setTokenKind(TransferGatewayTokenKind.ERC20)
    req.setTokenAmount(marshalBigUIntPB(amount))
    req.setTokenContract(tokenContract.MarshalPB())
    if (recipient) {
      req.setRecipient(recipient.MarshalPB())
    }

    return this.callAsync<void>('WithdrawToken', req)
  }

  /**
   * Sends a request to the DAppChain Gateway to begin withdrawal of ETH from the current
   * DAppChain account to an Ethereum account.
   * @param amount Amount to withdraw.
   * @param ethereumGateway Ethereum address of Ethereum Gateway.
   * @param recipient Ethereum address of the account the token should be withdrawn to, if this is
   *                  omitted the Gateway will attempt to use the Address Mapper to retrieve the
   *                  address of the Ethereum account mapped to the current DAppChain account.
   * @returns A promise that will be resolved when the DAppChain Gateway has accepted the withdrawal
   *          request.
   */
  withdrawETHAsync(amount: BN, ethereumGateway: Address, recipient?: Address): Promise<void> {
    const req = new TransferGatewayWithdrawETHRequest()
    req.setAmount(marshalBigUIntPB(amount))
    req.setMainnetGateway(ethereumGateway.MarshalPB())
    if (recipient) {
      req.setRecipient(recipient.MarshalPB())
    }

    return this.callAsync<void>('WithdrawETH', req)
  }

  /**
   * Retrieves the current withdrawal receipt (if any) for the given DAppChain account.
   * Withdrawal receipts are created by calling one of the withdraw methods.
   * @param owner DAppChain address of a user account.
   * @returns A promise that will be resolved with the withdrawal receipt, or null if no withdrawal
   *          receipt exists (this indicates there's no withdrawal from the specified account
   *          currently in progress).
   */
  async withdrawalReceiptAsync(owner: Address): Promise<IWithdrawalReceipt | null> {
    const tgWithdrawReceiptReq = new TransferGatewayWithdrawalReceiptRequest()
    tgWithdrawReceiptReq.setOwner(owner.MarshalPB())

    const result = await this.staticCallAsync(
      'WithdrawalReceipt',
      tgWithdrawReceiptReq,
      new TransferGatewayWithdrawalReceiptResponse()
    )

    const receipt = result.getReceipt()

    if (receipt) {
      let tokenId: BN | undefined
      let tokenAmount: BN | undefined
      let value: BN

      const tokenKind = receipt.getTokenKind()
      switch (tokenKind) {
        case TransferGatewayTokenKind.ERC721:
          tokenId = unmarshalBigUIntPB(receipt.getTokenId()!)
          value = tokenId
          break
        case TransferGatewayTokenKind.ERC721X:
          tokenId = unmarshalBigUIntPB(receipt.getTokenId()!)
        // fallthrough
        // tslint:disable-next-line: no-switch-case-fall-through
        default:
          tokenAmount = unmarshalBigUIntPB(receipt.getTokenAmount()!)
          value = tokenAmount
          break
      }

      return {
        tokenOwner: Address.UnmarshalPB(receipt.getTokenOwner()!),
        tokenContract: Address.UnmarshalPB(receipt.getTokenContract()!),
        tokenKind,
        tokenId,
        tokenAmount,
        withdrawalNonce: new BN(receipt.getWithdrawalNonce()!),
        value,
        sigs: receipt.getValidatorSignaturesList().map(utils.splitSignature)
      }
    }
    return null
  }

  /**
   * Attempt to transfer tokens that originated from the specified Ethereum contract, and that have
   * been deposited to the Ethereum Gateway, but haven't yet been received by the depositors on the
   * DAppChain because of a missing identity or contract mapping. This method can only be called by
   * the creator of the specified token contract, or the Gateway owner.
   *
   * @param tokenContract token contract to reclaim the tokens
   */
  async reclaimContractTokensAsync(tokenContract: Address): Promise<void> {
    const req = new TransferGatewayReclaimContractTokensRequest()
    req.setTokenContract(tokenContract.MarshalPB())
    return this.callAsync<void>('ReclaimContractTokens', req)
  }

  /**
   * Attempt to transfer any tokens that the caller may have deposited into the Ethereum Gateway
   * but hasn't yet received from the DAppChain Gateway because of a missing identity or contract
   * mapping.
   *
   * @param depositors Optional list of DAppChain accounts to reclaim tokens for, when set tokens
   *                   will be reclaimed for the specified accounts instead of the caller's account.
   *                   NOTE: Only the Gateway owner is authorized to provide a list of accounts.
   */
  async reclaimDepositorTokensAsync(depositors?: Array<Address>): Promise<void> {
    const req = new TransferGatewayReclaimDepositorTokensRequest()
    if (depositors && depositors.length > 0) {
      req.setDepositorsList(depositors.map((address: Address) => address.MarshalPB()))
    }
    return this.callAsync<void>('ReclaimDepositorTokens', req)
  }
}
