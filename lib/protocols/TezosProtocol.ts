import { ICoinProtocol } from './ICoinProtocol'
import BigNumber from 'bignumber.js'
import { IAirGapTransaction } from '..'
import * as nacl from 'tweetnacl'
import { generateWalletUsingDerivationPath } from '@aeternity/hd-wallet'
import axios, { AxiosError, AxiosResponse } from 'axios'
import * as bs58check from 'bs58check'
import { RawTezosTransaction, UnsignedTezosTransaction } from '../serializer/unsigned-transactions/tezos-transactions.serializer'
import { SignedTezosTransaction } from '../serializer/signed-transactions/tezos-transactions.serializer'
import * as sodium from 'libsodium-wrappers'
import { IAirGapSignedTransaction } from '../interfaces/IAirGapSignedTransaction'

export enum TezosOperationType {
  TRANSACTION = 'transaction',
  REVEAL = 'reveal'
}

export interface TezosBlockMetadata {
  protocol: string
  chain_id: string
  hash: string
  metadata: TezosBlockHeader
}

export interface TezosBlockHeader {
  level: number
  proto: number
  predecessor: string
  timestamp: string
  validation_pass: number
  operations_hash: string
  fitness: string[]
  context: string
  priority: number
  proof_of_work_nonce: string
  signature: string
}

export interface TezosWrappedOperation {
  branch: string
  contents: TezosOperation[]
}

export interface TezosSpendOperation extends TezosOperation {
  destination: string
  amount: string
  kind: TezosOperationType.TRANSACTION
}

export interface TezosOperation {
  storage_limit: string
  gas_limit: string
  counter: string
  fee: string
  source: string
  kind: TezosOperationType
}

export interface TezosRevealOperation extends TezosOperation {
  public_key: string
  kind: TezosOperationType.REVEAL
}

export class TezosProtocol implements ICoinProtocol {
  symbol = 'XTZ'
  name = 'Tezos'
  marketSymbol = 'xtz'
  feeSymbol = 'xtz'

  decimals = 6
  feeDecimals = 6 // micro tez is the smallest, 1000000 microtez is 1 tez
  identifier = 'xtz'

  // TODO this is just copied from another protocol, needs to be implemented with some "real" values.
  feeDefaults = {
    low: new BigNumber('0.00021'), // 21000 Gas * 2 Gwei
    medium: new BigNumber('0.000315'), // 21000 Gas * 15 Gwei
    high: new BigNumber('0.00084') // 21000 Gas * 40 Gwei
  }

  units = [
    {
      unitSymbol: 'XTZ',
      factor: new BigNumber(1)
    }
  ]

  supportsHD = false
  standardDerivationPath = `m/44h/1729h/0h/0h`
  addressValidationPattern = '^tz1[1-9A-Za-z]{33}$'

  // Tezos - We need to wrap these in Buffer due to non-compatible browser polyfills
  private tezosPrefixes = {
    tz1: Buffer.from(new Uint8Array([6, 161, 159])),
    tz2: Buffer.from(new Uint8Array([6, 161, 161])),
    tz3: Buffer.from(new Uint8Array([6, 161, 164])),
    edpk: Buffer.from(new Uint8Array([13, 15, 37, 217])),
    edsk: Buffer.from(new Uint8Array([43, 246, 78, 7])),
    edsig: Buffer.from(new Uint8Array([9, 245, 205, 134, 18])),
    branch: Buffer.from(new Uint8Array([1, 52]))
  }

  protected tezosChainId = 'PsddFKi32cMJ2qPjf43Qv5GDWLDPZb3T3bF6fLKiF5HtvHNU7aP'

  /**
   * Tezos Implemention of ICoinProtocol
   * @param jsonRPCAPI
   * @param baseApiUrl
   */
  constructor(public jsonRPCAPI = 'https://rpc.tezrpc.me', public baseApiUrl = 'https://api5.tzscan.io') {}

  /**
   * Returns the PublicKey as String, derived from a supplied hex-string
   * @param secret HEX-Secret from BIP39
   * @param derivationPath DerivationPath for Key
   */
  getPublicKeyFromHexSecret(secret: string, derivationPath: string): string {
    // TODO both AE and tezos use the same ECC curves (ed25519), probably using the same derivation method should work. This needs to be tested with ledger nano S. Also in the tezos world in general there is no concept of derivation path, maybe providing no path, should result in the same address like all other "standard" tezos clients out there.
    const { publicKey } = generateWalletUsingDerivationPath(Buffer.from(secret, 'hex'), derivationPath)
    return Buffer.from(publicKey).toString('hex')
  }

  /**
   * Returns the PrivateKey as Buffer, derived from a supplied hex-string
   * @param secret HEX-Secret from BIP39
   * @param derivationPath DerivationPath for Key
   */
  getPrivateKeyFromHexSecret(secret: string, derivationPath: string): Buffer {
    // TODO both AE and tezos use the same ECC curves (ed25519), probably using the same derivation method should work. This needs to be tested with ledger nano S. Also in the tezos world in general there is no concept of derivation path, maybe providing no path, should result in the same address like all other "standard" tezos clients out there.
    const { secretKey } = generateWalletUsingDerivationPath(Buffer.from(secret, 'hex'), derivationPath)
    return Buffer.from(secretKey)
  }

  getAddressFromPublicKey(publicKey: string): string {
    // using libsodium for now
    const payload = sodium.crypto_generichash(20, Buffer.from(publicKey, 'hex'))
    const address = bs58check.encode(Buffer.concat([this.tezosPrefixes.tz1, Buffer.from(payload)]))

    return address
  }

  async getTransactionsFromPublicKey(publicKey: string, limit: number, offset: number): Promise<IAirGapTransaction[]> {
    return this.getTransactionsFromAddresses([this.getAddressFromPublicKey(publicKey)], limit, offset)
  }

  async getTransactionsFromAddresses(addresses: string[], limit: number, offset: number): Promise<IAirGapTransaction[]> {
    /*
    const allTransactions = await Promise.all(
      addresses.map(address => {
        return axios.get(`${this.baseApiUrl}/v1/operations/${address}?type=Transaction&p=${offset}&number=${limit}`)
      })
    )

    const transactions: any[] = [].concat(
      ...allTransactions.map(axiosData => {
        return axiosData.data
      })
    )

    return transactions.map(obj => {
      const airGapTx: IAirGapTransaction = {
        amount: new BigNumber(obj.operations.amount),
        fee: new BigNumber(obj.operations.fee),
        from: [obj.operations.source.tz],
        isInbound: addresses.indexOf(obj.operations.destination.tz) !== -1,
        protocolIdentifier: this.identifier,
        to: [obj.operations.destination.tz],
        hash: obj.hash,
        blockHeight: obj.operations.op_level // TODO show correct height
      }

      return airGapTx
    })
    */
    return Promise.resolve([])
  }

  // TODO Not implemented yet, see https://github.com/kukai-wallet/kukai/blob/master/src/app/services/operation.service.ts line 462 it requires libsodium
  signWithPrivateKey(privateKey: Buffer, transaction: RawTezosTransaction): Promise<IAirGapSignedTransaction> {
    const watermark = '03'
    const watermarkedForgedOperationBytesHex: string = watermark + transaction.binaryTransaction
    const watermarkedForgedOperationBytes: Buffer = Buffer.from(watermarkedForgedOperationBytesHex, 'hex')
    const hashedWatermarkedOpBytes: Buffer = sodium.crypto_generichash(32, watermarkedForgedOperationBytes)

    const opSignature = nacl.sign.detached(hashedWatermarkedOpBytes, privateKey)
    const signedOpBytes: Buffer = Buffer.concat([Buffer.from(transaction.binaryTransaction, 'hex'), Buffer.from(opSignature)])

    return Promise.resolve(signedOpBytes.toString('hex'))
  }

  // TODO Not implemented yet. The only difference between signed and unsigned is the "signature" property in the json object, see https://github.com/kukai-wallet/kukai/blob/master/src/app/services/operation.service.ts line 61
  getTransactionDetails(unsignedTx: UnsignedTezosTransaction): IAirGapTransaction {
    // always take last operation, as operation 0 might be reveal - we should fix this properly
    const spendOperation = unsignedTx.transaction.jsonTransaction.contents[
      unsignedTx.transaction.jsonTransaction.contents.length - 1
    ] as TezosSpendOperation

    const airgapTx: IAirGapTransaction = {
      amount: new BigNumber(spendOperation.amount),
      fee: new BigNumber(spendOperation.fee),
      from: [spendOperation.source],
      isInbound: false,
      protocolIdentifier: this.identifier,
      to: [spendOperation.destination]
    }

    return airgapTx
  }

  // TODO Not implemented yet. The only difference between signed and unsigned is the "signature" property in the json object, see https://github.com/kukai-wallet/kukai/blob/master/src/app/services/operation.service.ts line 61
  getTransactionDetailsFromSigned(signedTx: SignedTezosTransaction): IAirGapTransaction {
    const airgapTx: IAirGapTransaction = {
      to: signedTx.from!, // TODO: Fix this
      protocolIdentifier: this.identifier,
      amount: signedTx.amount!,
      fee: signedTx.fee!,
      from: signedTx.from!,
      isInbound: true // TODO: Fix this
    }

    return airgapTx
  }

  async getBalanceOfAddresses(addresses: string[]): Promise<BigNumber> {
    let balance = new BigNumber(0)

    for (let address of addresses) {
      try {
        const { data } = await axios.get(`${this.jsonRPCAPI}/chains/main/blocks/head/context/contracts/${address}/balance`)
        balance = balance.plus(new BigNumber(data))
      } catch (error) {
        // if node returns 404 (which means 'no account found'), go with 0 balance
        if (error.response.status !== 404) {
          throw error
        }
      }
    }

    return balance
  }

  getBalanceOfPublicKey(publicKey: string): Promise<BigNumber> {
    const address = this.getAddressFromPublicKey(publicKey)
    return this.getBalanceOfAddresses([address])
  }

  async prepareTransactionFromPublicKey(
    publicKey: string,
    recipients: string[],
    values: BigNumber[],
    fee: BigNumber
  ): Promise<RawTezosTransaction> {
    let counter = new BigNumber(1)
    let branch: string

    const operations: TezosOperation[] = []

    try {
      const results = await Promise.all([
        axios.get(`${this.jsonRPCAPI}/chains/main/blocks/head/context/contracts/${this.getAddressFromPublicKey(publicKey)}/counter`),
        axios.get(`${this.jsonRPCAPI}/chains/main/blocks/head/hash`),
        axios.get(`${this.jsonRPCAPI}/chains/main/blocks/head/context/contracts/${this.getAddressFromPublicKey(publicKey)}/manager_key`)
      ])

      counter = new BigNumber(results[0].data).plus(1)
      branch = results[1].data

      const accountManager = results[2].data

      // check if we have revealed the key already
      if (!accountManager.key) {
        operations.push(this.createRevealOperation(counter, publicKey))
        counter = counter.plus(1)
      }
    } catch (error) {
      throw error
    }

    const balance = await this.getBalanceOfPublicKey(publicKey)

    if (balance.isLessThan(fee.plus(values[0]))) {
      throw new Error('not enough balance')
    }

    const spendOperation: TezosSpendOperation = {
      kind: TezosOperationType.TRANSACTION,
      fee: fee.toFixed(),
      gas_limit: '10100', // taken from eztz
      storage_limit: '0', // taken from eztz
      amount: values[0].toFixed(),
      counter: counter.toFixed(),
      destination: recipients[0],
      source: this.getAddressFromPublicKey(publicKey)
    }

    operations.push(spendOperation)

    try {
      const tezosWrappedOperation: TezosWrappedOperation = {
        branch: branch,
        contents: operations
      }

      return {
        jsonTransaction: tezosWrappedOperation,
        binaryTransaction: this.forgeTezosOperation(tezosWrappedOperation)
      }
    } catch (error) {
      console.warn(error.message)
      throw new Error('Forging Tezos TX failed.')
    }
  }

  async broadcastTransaction(rawTransaction: IAirGapSignedTransaction): Promise<string> {
    const payload = rawTransaction

    try {
      const { data: injectionResponse } = await axios.post(`${this.jsonRPCAPI}/injection/operation?chain=main`, JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' }
      })
      // returns hash if successful
      return injectionResponse
    } catch (err) {
      console.warn((err as AxiosError).message, ((err as AxiosError).response as AxiosResponse).statusText)
      throw new Error('broadcasting failed')
    }
  }

  getExtendedPrivateKeyFromHexSecret(secret: string, derivationPath: string): string {
    throw new Error('extended private key support for Tezos not implemented')
  }

  getBalanceOfExtendedPublicKey(extendedPublicKey: string, offset: number): Promise<BigNumber> {
    return Promise.reject('extended public balance for Tezos not implemented')
  }

  signWithExtendedPrivateKey(extendedPrivateKey: string, transaction: any): Promise<string> {
    return Promise.reject('extended private key signing for Tezos not implemented')
  }

  getAddressFromExtendedPublicKey(extendedPublicKey: string, visibilityDerivationIndex: number, addressDerivationIndex: number): string {
    return ''
  }

  getAddressesFromExtendedPublicKey(
    extendedPublicKey: string,
    visibilityDerivationIndex: number,
    addressCount: number,
    offset: number
  ): string[] {
    return []
  }

  getTransactionsFromExtendedPublicKey(extendedPublicKey: string, limit: number, offset: number): Promise<IAirGapTransaction[]> {
    return Promise.reject('fetching txs using extended public key for tezos not implemented')
  }

  prepareTransactionFromExtendedPublicKey(
    extendedPublicKey: string,
    offset: number,
    recipients: string[],
    values: BigNumber[],
    fee: BigNumber
  ): Promise<RawTezosTransaction> {
    return Promise.reject('extended public key tx for tezos not implemented')
  }

  checkAndRemovePrefixToHex(base58CheckEncodedPayload: string, tezosPrefix: Uint8Array) {
    const prefixHex = Buffer.from(tezosPrefix).toString('hex')
    const payload = bs58check.decode(base58CheckEncodedPayload).toString('hex')
    if (payload.startsWith(prefixHex)) {
      return payload.substring(tezosPrefix.length * 2)
    } else {
      throw new Error('payload did not match prefix: ' + tezosPrefix)
    }
  }

  forgeTezosOperation(tezosWrappedOperation: TezosWrappedOperation) {
    // taken from http://tezos.gitlab.io/mainnet/api/p2p.html
    const cleanedBranch = this.checkAndRemovePrefixToHex(tezosWrappedOperation.branch, this.tezosPrefixes.branch) // ignore the tezos prefix
    if (cleanedBranch.length !== 64) {
      // must be 32 bytes
      throw new Error('provided branch is invalid')
    }

    let branchHexString = cleanedBranch // ignore the tezos prefix

    const forgedOperation = tezosWrappedOperation.contents.map(operation => {
      let resultHexString = ''
      if (operation.kind !== TezosOperationType.TRANSACTION && operation.kind !== TezosOperationType.REVEAL) {
        throw new Error('currently unsupported operation type supplied ' + operation.kind)
      }

      if (operation.kind === TezosOperationType.TRANSACTION) {
        resultHexString += '08' // because this is a transaction operation
      } else if (operation.kind === TezosOperationType.REVEAL) {
        resultHexString += '07' // because this is a reveal operation
      }

      let cleanedSource = this.checkAndRemovePrefixToHex(operation.source, this.tezosPrefixes.tz1) // currently we only support tz1 addresses
      if (cleanedSource.length > 44) {
        // must be less or equal 22 bytes
        throw new Error('provided source is invalid')
      }

      while (cleanedSource.length !== 44) {
        // fill up with 0s to match 22bytes
        cleanedSource = '0' + cleanedSource
      }

      resultHexString += cleanedSource
      resultHexString += this.bigNumberToZarith(new BigNumber(operation.fee))
      resultHexString += this.bigNumberToZarith(new BigNumber(operation.counter))
      resultHexString += this.bigNumberToZarith(new BigNumber(operation.gas_limit))
      resultHexString += this.bigNumberToZarith(new BigNumber(operation.storage_limit))

      if (operation.kind === TezosOperationType.TRANSACTION) {
        resultHexString += this.bigNumberToZarith(new BigNumber((operation as TezosSpendOperation).amount))
        let cleanedDestination = this.checkAndRemovePrefixToHex((operation as TezosSpendOperation).destination, this.tezosPrefixes.tz1)

        if (cleanedDestination.length > 44) {
          // must be less or equal 22 bytes
          throw new Error('provided destination is invalid')
        }

        while (cleanedDestination.length !== 44) {
          // fill up with 0s to match 22bytes
          cleanedDestination = '0' + cleanedDestination
        }

        resultHexString += cleanedDestination

        resultHexString += '00' // because we have no additional parameters
      }

      if (operation.kind === TezosOperationType.REVEAL) {
        let cleanedPublicKey = this.checkAndRemovePrefixToHex((operation as TezosRevealOperation).public_key, this.tezosPrefixes.edpk)

        if (cleanedPublicKey.length === 32) {
          // must be equal 32 bytes
          throw new Error('provided public key is invalid')
        }

        resultHexString += '00' + cleanedPublicKey
      }

      return resultHexString
    })

    return branchHexString + forgedOperation.join('')
  }

  bigNumberToZarith(inputNumber: BigNumber) {
    let bitString = inputNumber.toString(2)
    while (bitString.length % 7 !== 0) {
      bitString = '0' + bitString // fill up with leading '0'
    }

    let resultHexString = ''
    // because it's little endian we start from behind...
    for (let i = bitString.length; i > 0; i -= 7) {
      let bitStringSection = bitString.substring(i - 7, i)
      if (i === 7) {
        // the last byte will show it's the last with a leading '0'
        bitStringSection = '0' + bitStringSection
      } else {
        // the others will show more will come with a leading '1'
        bitStringSection = '1' + bitStringSection
      }
      let hexStringSection = parseInt(bitStringSection, 2).toString(16)

      if (hexStringSection.length % 2) {
        hexStringSection = '0' + hexStringSection
      }

      resultHexString += hexStringSection
    }
    return resultHexString
  }

  private createRevealOperation(counter: BigNumber, publicKey: string): TezosRevealOperation {
    const operation: TezosRevealOperation = {
      kind: TezosOperationType.REVEAL,
      fee: '1300',
      gas_limit: '10000', // taken from conseiljs
      storage_limit: '0', // taken from conseiljs
      counter: counter.toFixed(),
      public_key: bs58check.encode(Buffer.concat([this.tezosPrefixes.edpk, Buffer.from(publicKey, 'hex')])),
      source: this.getAddressFromPublicKey(publicKey)
    }
    return operation
  }
}
