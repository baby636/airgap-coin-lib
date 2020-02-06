import BECH32 = require('../../dependencies/src/bech32-1.1.3/index')
import BigNumber from '../../dependencies/src/bignumber.js-9.0.0/bignumber'
import { BIP32Interface, fromSeed } from '../../dependencies/src/bip32-2.0.4/src/index'
import { mnemonicToSeed, validateMnemonic } from '../../dependencies/src/bip39-2.5.0/index'
import RIPEMD160 = require('../../dependencies/src/ripemd160-2.0.2/index')
import SECP256K1 = require('../../dependencies/src/secp256k1-3.7.1/elliptic')
import * as sha from '../../dependencies/src/sha.js-2.4.11/index'
import { IAirGapTransaction } from '../../interfaces/IAirGapTransaction'
import { SignedCosmosTransaction } from '../../serializer/schemas/definitions/transaction-sign-response-cosmos'
import { UnsignedCosmosTransaction } from '../../serializer/types'
import { CurrencyUnit, FeeDefaults, ICoinProtocol } from '../ICoinProtocol'
import { ICoinSubProtocol } from '../ICoinSubProtocol'
import { NonExtendedProtocol } from '../NonExtendedProtocol'

import { CosmosDelegateMessage } from './cosmos-message/CosmosDelegateMessage'
import { CosmosMessageType } from './cosmos-message/CosmosMessage'
import { CosmosSendMessage } from './cosmos-message/CosmosSendMessage'
import { CosmosWithdrawDelegationRewardMessage } from './cosmos-message/CosmosWithdrawDelegationRewardMessage'
import { CosmosCoin } from './CosmosCoin'
import { CosmosFee } from './CosmosFee'
import { CosmosInfoClient } from './CosmosInfoClient'
import {
  CosmosAccount,
  CosmosDelegation,
  CosmosNodeClient,
  CosmosNodeInfo,
  CosmosValidator,
  CosmosUnbondingDelegation
} from './CosmosNodeClient'
import { CosmosTransaction } from './CosmosTransaction'

export interface KeyPair {
  publicKey: Buffer
  privateKey: Buffer
}

export class CosmosProtocol extends NonExtendedProtocol implements ICoinProtocol {
  public symbol: string = 'ATOM'
  public name: string = 'Cosmos'
  public marketSymbol: string = 'atom'
  public feeSymbol: string = 'atom'
  public feeDefaults: FeeDefaults = {
    // TODO: verify if these values are ok
    low: '0.0005',
    medium: '0.005',
    high: '0.0075'
  }
  public decimals: number = 6 // TODO: verify these values
  public feeDecimals: number = 6
  public identifier: string = 'cosmos'
  public units: CurrencyUnit[] = [
    {
      unitSymbol: 'atom',
      factor: '1'
    },
    {
      unitSymbol: 'uatom',
      factor: '0.000001'
    }
  ]
  public supportsHD: boolean = false
  public standardDerivationPath: string = `m/44'/118'/0'/0/0`
  public addressIsCaseSensitive: boolean = false
  public addressValidationPattern: string = '^(cosmos|cosmosvaloper)[a-zA-Z0-9]{39}$'
  public addressPlaceholder: string = 'cosmos...'
  public blockExplorer: string = 'https://www.mintscan.io'
  public subProtocols?: (ICoinProtocol & ICoinSubProtocol)[] | undefined

  private readonly addressPrefix: string = 'cosmos'
  private readonly defaultGas: BigNumber = new BigNumber('200000')

  constructor(
    public readonly infoClient: CosmosInfoClient = new CosmosInfoClient(),
    public readonly nodeClient: CosmosNodeClient = new CosmosNodeClient('https://cosmos-cosmoshub-2.kubernetes.papers.tech', true)
  ) {
    super()
  }

  public getBlockExplorerLinkForAddress(address: string): string {
    return `${this.blockExplorer}/account/${address}`
  }

  public getBlockExplorerLinkForTxId(txId: string): string {
    return `${this.blockExplorer}/txs/${txId}`
  }

  public generateKeyPair(mnemonic: string, derivationPath: string = this.standardDerivationPath): KeyPair {
    validateMnemonic(mnemonic)
    const seed = mnemonicToSeed(mnemonic)
    const node = fromSeed(seed)

    return this.generateKeyPairFromNode(node, derivationPath)
  }

  private generateKeyPairFromNode(node: BIP32Interface, derivationPath: string): KeyPair {
    const keys = node.derivePath(derivationPath)
    const privateKey = keys.privateKey
    if (privateKey === undefined) {
      throw new Error('Cannot generate private key')
    }

    return {
      publicKey: keys.publicKey,
      privateKey
    }
  }

  public getPublicKeyFromHexSecret(secret: string, derivationPath: string): string {
    const node: BIP32Interface = fromSeed(Buffer.from(secret, 'hex'))

    return this.generateKeyPairFromNode(node, derivationPath).publicKey.toString('hex')
  }

  public getPublicKeyFromPrivateKey(privateKey: Buffer): Buffer {
    const publicKey = SECP256K1.publicKeyCreate(privateKey)

    return Buffer.from(publicKey, 'binary')
  }

  public getPrivateKeyFromHexSecret(secret: string, derivationPath: string): Buffer {
    const node = fromSeed(Buffer.from(secret, 'hex'))

    return this.generateKeyPairFromNode(node, derivationPath).privateKey
  }

  public async getAddressFromPublicKey(publicKey: string): Promise<string> {
    const pubkey = Buffer.from(publicKey, 'hex')

    const sha256Hash: string = sha('sha256')
      .update(pubkey)
      .digest()
    const hash = new RIPEMD160().update(Buffer.from(sha256Hash)).digest()
    const address = BECH32.encode(this.addressPrefix, BECH32.toWords(hash))

    return address
  }

  public async getAddressesFromPublicKey(publicKey: string): Promise<string[]> {
    return [await this.getAddressFromPublicKey(publicKey)]
  }

  public async getTransactionsFromPublicKey(publicKey: string, limit: number, offset: number): Promise<IAirGapTransaction[]> {
    return this.getTransactionsFromAddresses([await this.getAddressFromPublicKey(publicKey)], limit, offset)
  }

  public async getTransactionsFromAddresses(addresses: string[], limit: number, offset: number): Promise<IAirGapTransaction[]> {
    const promises: Promise<IAirGapTransaction[]>[] = []
    for (const address of addresses) {
      promises.push(this.infoClient.fetchTransactions(this.identifier, address, offset, limit))
    }

    return Promise.all(promises).then(transactions => transactions.reduce((current, next) => current.concat(next)))
  }

  public async signWithPrivateKey(privateKey: Buffer, transaction: CosmosTransaction): Promise<string> {
    const publicKey = this.getPublicKeyFromPrivateKey(privateKey)
    const toSign = transaction.toRPCBody()
    // TODO: check if sorting is needed
    const sha256Hash: string = sha('sha256')
      .update(Buffer.from(JSON.stringify(toSign)))
      .digest()
    const hash = Buffer.from(sha256Hash)
    const signed = SECP256K1.sign(hash, privateKey)
    const sigBase64 = Buffer.from(signed.signature, 'binary').toString('base64')
    const signedTransaction = {
      tx: {
        msg: toSign.msgs,
        fee: toSign.fee,
        signatures: [
          {
            signature: sigBase64,
            pub_key: {
              type: 'tendermint/PubKeySecp256k1',
              value: publicKey.toString('base64')
            }
          }
        ],
        memo: toSign.memo
      },
      mode: 'sync'
    }

    return JSON.stringify(signedTransaction)
  }

  public async getTransactionDetails(transaction: UnsignedCosmosTransaction): Promise<IAirGapTransaction[]> {
    const result = transaction.transaction.toAirGapTransactions(this.identifier)

    return result
  }

  public async getTransactionDetailsFromSigned(transaction: SignedCosmosTransaction): Promise<IAirGapTransaction[]> {
    const json = JSON.parse(transaction.transaction).tx
    const fee: string = (json.fee.amount as { amount: string }[])
      .map(({ amount }: { amount: string }) => new BigNumber(amount))
      .reduce((current: BigNumber, next: BigNumber) => current.plus(next))
      .toString(10)
    const result = json.msg
      .map(message => {
        const type: string = message.type
        switch (type) {
          case CosmosMessageType.Send.value:
            const sendMessage = CosmosSendMessage.fromRPCBody(message)

            return sendMessage.toAirGapTransaction(this.identifier, fee)
          case CosmosMessageType.Undelegate.value:
          case CosmosMessageType.Delegate.value:
            const delegateMessage = CosmosDelegateMessage.fromRPCBody(message)

            return delegateMessage.toAirGapTransaction(this.identifier, fee)
          case CosmosMessageType.WithdrawDelegationReward.value:
            const withdrawMessage = CosmosWithdrawDelegationRewardMessage.fromRPCBody(message)

            return withdrawMessage.toAirGapTransaction(this.identifier, fee)
          default:
            throw Error('Unknown transaction')
        }
      })
      .map((tx: IAirGapTransaction) => {
        if (!tx.transactionDetails) {
          tx.transactionDetails = {}
        }
        tx.transactionDetails.accountNumber = json.accountNumber
        tx.transactionDetails.chainID = json.chainID
        tx.transactionDetails.memo = json.memo
        tx.transactionDetails.sequence = json.sequence

        return tx
      })

    return result
  }

  public async getBalanceOfAddresses(addresses: string[]): Promise<string> {
    const promises: Promise<BigNumber>[] = []
    for (const address of addresses) {
      promises.push(this.nodeClient.fetchBalance(address, true))
    }

    return (
      await Promise.all(promises).then((balances: BigNumber[]) => {
        return balances.reduce((current: BigNumber, next: BigNumber) => {
          return current.plus(next)
        })
      })
    ).toString(10)
  }

  public async getBalanceOfPublicKey(publicKey: string): Promise<string> {
    return this.getBalanceOfAddresses([await this.getAddressFromPublicKey(publicKey)])
  }

  public async fetchAvailableBalance(address: string): Promise<BigNumber> {
    return this.nodeClient.fetchBalance(address)
  }

  public async prepareTransactionFromPublicKey(
    publicKey: string,
    recipients: string[],
    values: string[],
    fee: string,
    data?: unknown
  ): Promise<CosmosTransaction> {
    const wrappedValues: BigNumber[] = values.map((value: string) => new BigNumber(value))
    const wrappedFee: BigNumber = new BigNumber(fee)

    if (recipients.length !== wrappedValues.length) {
      return Promise.reject('recipients length does not match with values')
    }

    const address: string = await this.getAddressFromPublicKey(publicKey)
    const nodeInfo: CosmosNodeInfo = await this.nodeClient.fetchNodeInfo()
    const account: CosmosAccount = await this.nodeClient.fetchAccount(address)

    const balance: BigNumber = new BigNumber(await this.getBalanceOfAddresses([address]))

    if (balance.lt(values.reduce((pv: BigNumber, cv: string) => pv.plus(cv), wrappedFee))) {
      throw new Error('not enough balance')
    }

    const messages: CosmosSendMessage[] = []
    for (let i: number = 0; i < recipients.length; ++i) {
      const message: CosmosSendMessage = new CosmosSendMessage(address, recipients[i], [
        new CosmosCoin('uatom', wrappedValues[i].toString(10))
      ])
      messages.push(message)
    }
    const memo: string = data !== undefined && typeof data === 'string' ? data : ''
    const transaction: CosmosTransaction = new CosmosTransaction(
      messages,
      new CosmosFee([new CosmosCoin('uatom', wrappedFee.toString(10))], this.defaultGas.toString(10)),
      memo,
      nodeInfo.network,
      account.value.account_number,
      account.value.sequence
    )

    return transaction
  }

  public async delegate(
    publicKey: string,
    validatorAddress: string,
    amount: BigNumber,
    undelegate: boolean = false,
    memo?: string
  ): Promise<CosmosTransaction> {
    const address: string = await this.getAddressFromPublicKey(publicKey)
    const nodeInfo: CosmosNodeInfo = await this.nodeClient.fetchNodeInfo()
    const account: CosmosAccount = await this.nodeClient.fetchAccount(address)
    const message: CosmosDelegateMessage = new CosmosDelegateMessage(
      address,
      validatorAddress,
      new CosmosCoin('uatom', amount.toString(10)),
      undelegate
    )

    return new CosmosTransaction(
      [message],
      new CosmosFee(
        [new CosmosCoin('uatom', new BigNumber(this.feeDefaults.medium).shiftedBy(this.feeDecimals).toString(10))],
        this.defaultGas.toString(10)
      ),
      memo !== undefined ? memo : '',
      nodeInfo.network,
      account.value.account_number,
      account.value.sequence
    )
  }
  public async withdrawDelegationRewards(publicKey: string, validatorAddresses: string[], memo?: string): Promise<CosmosTransaction> {
    const address: string = await this.getAddressFromPublicKey(publicKey)
    const nodeInfo: CosmosNodeInfo = await this.nodeClient.fetchNodeInfo()
    const account: CosmosAccount = await this.nodeClient.fetchAccount(address)
    const messages: CosmosWithdrawDelegationRewardMessage[] = validatorAddresses.map(
      (validatorAddress: string) => new CosmosWithdrawDelegationRewardMessage(address, validatorAddress)
    )

    return new CosmosTransaction(
      messages,
      new CosmosFee(
        [new CosmosCoin('uatom', new BigNumber(this.feeDefaults.medium).shiftedBy(this.feeDecimals).toString(10))],
        this.defaultGas.toString(10)
      ),
      memo !== undefined ? memo : '',
      nodeInfo.network,
      account.value.account_number,
      account.value.sequence
    )
  }

  public async withdrawAllDelegationRewards(delegatorAddress: string, fee: BigNumber, memo?: string): Promise<string> {
    const nodeInfo: CosmosNodeInfo = await this.nodeClient.fetchNodeInfo()
    const account: CosmosAccount = await this.nodeClient.fetchAccount(delegatorAddress)

    return this.nodeClient.withdrawAllDelegationRewards(
      delegatorAddress,
      nodeInfo.network,
      account.value.account_number,
      account.value.sequence,
      this.defaultGas,
      fee,
      memo !== undefined ? memo : ''
    )
  }

  public async fetchTotalReward(delegatorAddress: string): Promise<BigNumber> {
    return this.nodeClient.fetchTotalReward(delegatorAddress)
  }

  public async fetchRewardForDelegation(delegatorAddress: string, validatorAddress: string): Promise<BigNumber> {
    return this.nodeClient.fetchRewardForDelegation(delegatorAddress, validatorAddress)
  }

  public async fetchDelegations(address: string): Promise<CosmosDelegation[]> {
    return this.nodeClient.fetchDelegations(address)
  }

  public async fetchTotalDelegatedAmount(address: string): Promise<BigNumber> {
    const delegations = await this.fetchDelegations(address)
    return new BigNumber(delegations.map(delegation => parseFloat(delegation.shares)).reduce((a, b) => a + b, 0))
  }

  public async fetchValidator(address: string): Promise<CosmosValidator> {
    return this.nodeClient.fetchValidator(address)
  }
  public async fetchUnbondingDelegations(delegatorAddress: string): Promise<CosmosUnbondingDelegation[]> {
    return this.nodeClient.fetchUnbondingDelegations(delegatorAddress)
  }

  public async fetchTotalUnbondingAmount(address: string): Promise<BigNumber> {
    const unbondingDelegations: CosmosUnbondingDelegation[] = await this.fetchUnbondingDelegations(address)
    if (unbondingDelegations) {
      return new BigNumber(unbondingDelegations.map(delegation => parseFloat(delegation.balance)).reduce((a, b) => a + b, 0))
    }
    return new BigNumber(0)
  }

  public async fetchValidators(): Promise<CosmosValidator[]> {
    return this.nodeClient.fetchValidators()
  }
  public async fetchSelfDelegation(address: string): Promise<CosmosDelegation> {
    return this.nodeClient.fetchSelfDelegation(address)
  }

  public async broadcastTransaction(rawTransaction: string): Promise<string> {
    return this.nodeClient.broadcastSignedTransaction(rawTransaction)
  }

  public async signMessage(message: string, privateKey: Buffer): Promise<string> {
    throw new Error('Method not implemented.')
  }

  public async verifyMessage(message: string, signature: string, publicKey: Buffer): Promise<boolean> {
    throw new Error('Method not implemented.')
  }
}