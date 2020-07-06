import axios, { AxiosResponse } from '../../../dependencies/src/axios-0.19.0/index'
import { BigMapPredicate } from '../types/fa/BigMapPredicate'
import { BigMapRequest } from '../types/fa/BigMapRequest'
import { BigMapResponse } from '../types/fa/BigMapResult'
import { MichelineNode, MichelineTypeNode } from '../types/micheline/MichelineNode'
import { MichelsonOr } from '../types/michelson/generics/MichelsonOr'
import { MichelsonType } from '../types/michelson/MichelsonType'
import {
  MichelsonAnnotationPrefix,
  MichelsonTypeMeta,
  MichelsonTypeMetaCreateValueConfiguration
} from '../types/michelson/MichelsonTypeMeta'
import { TezosTransactionParameters } from '../types/operations/Transaction'
import { TezosContractCode } from '../types/TezosContractCode'
import { isMichelineNode } from '../types/utils'

import { TezosContractCall } from './TezosContractCall'
import { TezosContractEntrypoint } from './TezosContractEntrypoint'

export interface TezosContractConfiguration {
  address: string
  nodeRPCURL: string
  conseilAPIURL: string
  conseilNetwork: string
  conseilAPIKey: string
}

export class TezosContract {
  private static readonly DEFAULT_ENTRYPOINT = 'default'

  public entrypoints?: Map<string, TezosContractEntrypoint>
  public entrypointsPromise?: Promise<void>

  public bigMapIDs?: number[]
  public bigMapIDsPromise?: Promise<void>

  private readonly address: string
  private readonly nodeRPCURL: string
  private readonly conseilAPIURL: string
  private readonly conseilNetwork: string
  private readonly conseilAPIKey: string

  constructor(configuration: TezosContractConfiguration) {
    this.address = configuration.address
    this.nodeRPCURL = configuration.nodeRPCURL
    this.conseilAPIURL = configuration.conseilAPIURL
    this.conseilNetwork = configuration.conseilNetwork
    this.conseilAPIKey = configuration.conseilAPIKey
  }

  public async bigMapValues(request: BigMapRequest = {}): Promise<BigMapResponse[]> {
    const bigMapID: number = request?.bigMapID ?? await this.getBigMapID(request.bigMapFilter)

    const predicates: { field: string; operation: string; set: any[] }[] = [
      {
        field: 'big_map_id',
        operation: 'eq',
        set: [bigMapID]
      },
      ...(request.predicates ?? [])
    ]

    return this.apiRequest('big_map_contents', {
      fields: ['key', 'key_hash', 'value'],
      predicates
    })
  }

  public async createContractCall(entrypointName: string, value: unknown): Promise<TezosContractCall> {
    await this.waitForEntrypoints()

    const entrypoint: TezosContractEntrypoint | undefined = this.entrypoints?.get(entrypointName)
    if (!entrypoint) {
      return this.createDefaultContractCall(value)
    }

    return this.createEntrypointContractCall(entrypoint, value)
  }

  public async parseContractCall(json: TezosTransactionParameters): Promise<TezosContractCall> {
    await this.waitForEntrypoints()

    const entrypoint: TezosContractEntrypoint | undefined = this.entrypoints?.get(json.entrypoint)
    if (!entrypoint) {
      return Promise.reject(`Couldn't parse the contract call, unknown entrypoint: ${json.entrypoint}`)
    }

    return this.createEntrypointContractCall(entrypoint, json.value, {
      lazyEval: false,
      onNext: (meta: MichelsonTypeMeta, _raw: unknown, value: MichelsonType): void => {
        const argName: string | undefined = meta.getAnnotation(MichelsonAnnotationPrefix.FIELD, MichelsonAnnotationPrefix.TYPE)
        if (argName) {
          value.setName(argName)
        }
      },
    })
  }

  public async normalizeContractCallParameters(
    json: Partial<TezosTransactionParameters> & Pick<TezosTransactionParameters, 'value'> | MichelineNode, 
    fallbackEntrypoint?: string
  ): Promise<TezosTransactionParameters> {
    const entrypoint: string | undefined = 'entrypoint' in json ? json.entrypoint : undefined
    const value: MichelineNode = 'value' in json ? json.value : json

    if (entrypoint !== undefined && entrypoint !== TezosContract.DEFAULT_ENTRYPOINT) {
      return {
        entrypoint,
        value
      }
    }

    if (!MichelsonOr.isOr(value)) {
      return {
        entrypoint: fallbackEntrypoint ?? TezosContract.DEFAULT_ENTRYPOINT,
        value
      }
    }

    await this.waitForEntrypoints()

    const defaultEntrypoint: TezosContractEntrypoint | undefined = this.entrypoints?.get(TezosContract.DEFAULT_ENTRYPOINT)
    if (!defaultEntrypoint) {
      throw new Error('Could not fetch default entrypoint.')
    }

    let normalizedEntrypoint: [string, MichelineNode] | undefined
    defaultEntrypoint.type.createValue(value, {
      beforeNext: (meta: MichelsonTypeMeta, raw: unknown): void => {
        const entrypointName: string | undefined = meta.getAnnotation(MichelsonAnnotationPrefix.FIELD)
        if (entrypointName && isMichelineNode(raw)) {
          normalizedEntrypoint = [entrypointName, raw]
        }
      },
      onNext: (_meta: MichelsonTypeMeta, _raw: unknown, michelsonValue: MichelsonType): void => {
        if (michelsonValue instanceof MichelsonOr) {
          michelsonValue.eval()
        }
      }
    })

    return {
      entrypoint: normalizedEntrypoint ? normalizedEntrypoint[0] : (fallbackEntrypoint ?? defaultEntrypoint.name),
      value: normalizedEntrypoint ? normalizedEntrypoint[1] : value
    }
  }

  private createDefaultContractCall(value: unknown): TezosContractCall {
    return new TezosContractCall(TezosContract.DEFAULT_ENTRYPOINT, value instanceof MichelsonType ? value : undefined)
  }

  private createEntrypointContractCall(
    entrypoint: TezosContractEntrypoint,
    value: unknown,
    configuration: MichelsonTypeMetaCreateValueConfiguration = {}
  ): TezosContractCall {
    return new TezosContractCall(entrypoint.name, entrypoint.type.createValue(value, configuration))
  }

  private async getBigMapID(predicates?: BigMapPredicate[]): Promise<number> {
    await this.waitForBigMapIDs()

    if (this.bigMapIDs?.length === 1) {
      return this.bigMapIDs[0]
    }

    if (!predicates) {
      throw new Error("Contract has more that one BigMap, provide ID or predicates to select one.")
    }

    const response = await this.apiRequest<Record<'big_map_id', number>[]>('big_maps', {
      fields: ['big_map_id'],
      predicates: [
        {
          field: 'big_map_id',
          operation: 'in',
          set: this.bigMapIDs
        },
        ...predicates
      ]
    })

    if (response.length === 0) {
      throw new Error('BigMap ID not found')
    }

    if (response.length > 1) {
      throw new Error("More than one BigMap ID has been found for the predicates.")
    }

    return response[0].big_map_id
  }

  private async waitForBigMapIDs(): Promise<void> {
    if (this.bigMapIDs !== undefined) {
      return
    }

    if (this.bigMapIDsPromise === undefined) {
      this.bigMapIDsPromise = this.apiRequest<Record<'big_map_id', number>[]>('originated_account_maps', {
        fields: ['big_map_id'],
        predicates: [
          {
            field: 'account_id',
            operation: 'eq',
            set: [this.address]
          }
        ]
      })
        .then((response) => {
          if (response.length === 0) {
            throw new Error('BigMap IDs not found')
          }

          this.bigMapIDs = response.map((entry) => entry.big_map_id)
        })
        .finally(() => {
          this.bigMapIDsPromise = undefined
        })
    }

    return this.bigMapIDsPromise
  }

  private async waitForEntrypoints(): Promise<void> {
    if (this.entrypoints !== undefined) {
      return
    }

    if (this.entrypointsPromise === undefined) {
      const codePromise: Promise<Record<'code', TezosContractCode[]>> = this.nodeRequest('script')
      const entrypointsPromise: Promise<Record<'entrypoints', Record<string, MichelineTypeNode>>> = this.nodeRequest('entrypoints')

      this.entrypointsPromise = Promise.all([
        codePromise, 
        entrypointsPromise
      ]).then(([codeResponse, entrypointsResponse]) => {
        if (entrypointsResponse.entrypoints[TezosContract.DEFAULT_ENTRYPOINT] === undefined) {
          const parameter = codeResponse.code.find((primitiveApplication) => primitiveApplication.prim === 'parameter')
          if (parameter) {
            entrypointsResponse.entrypoints[TezosContract.DEFAULT_ENTRYPOINT] = parameter.args ? parameter.args[0] : []
          }
        }

        this.entrypoints = new Map(
          TezosContractEntrypoint.fromJSON(entrypointsResponse.entrypoints).map((entrypoint: TezosContractEntrypoint) => 
            [entrypoint.name, entrypoint]
          )
        )
      }).finally(() => {
        this.entrypointsPromise = undefined
      })
    }

    return this.entrypointsPromise
  }

  private async nodeRequest<T>(endpoint: string): Promise<T> {
    const response: AxiosResponse<T> = await axios.get(
      `${this.nodeRPCURL}/chains/main/blocks/head/context/contracts/${this.address}/${endpoint}`
    )

    return response.data
  }

  private async apiRequest<T>(endpoint: string, body: any): Promise<T> {
    const response: AxiosResponse<T> = await axios.post(
      `${this.conseilAPIURL}/v2/data/tezos/${this.conseilNetwork}/${endpoint}`, 
      body, 
      {
        headers: { 
          'Content-Type': 'application/json', 
          apiKey: this.conseilAPIKey
        }
      }
    )

    return response.data
  }
}