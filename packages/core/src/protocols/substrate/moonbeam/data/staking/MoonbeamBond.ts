import { SCALEDecoder, SCALEDecodeResult } from '../../../common/data/scale/SCALEDecoder'
import { SCALEAccountId } from '../../../common/data/scale/type/SCALEAccountId'
import { SCALEClass } from '../../../common/data/scale/type/SCALEClass'
import { SCALEInt } from '../../../common/data/scale/type/SCALEInt'
import { SCALEType } from '../../../common/data/scale/type/SCALEType'
import { SubstrateNetwork } from '../../../SubstrateNetwork'

export class MoonbeamBond extends SCALEClass {
  public static decode(runtimeVersion: number | undefined, raw: string): SCALEDecodeResult<MoonbeamBond> {
    const decoder = new SCALEDecoder(SubstrateNetwork.MOONBEAM, runtimeVersion, raw)

    const owner = decoder.decodeNextAccountId(20)
    const amount = decoder.decodeNextInt(128)

    return {
      bytesDecoded: owner.bytesDecoded + amount.bytesDecoded,
      decoded: new MoonbeamBond(owner.decoded, amount.decoded)
    }
  }

  protected scaleFields: SCALEType[] = [this.owner, this.amount]

  private constructor(public readonly owner: SCALEAccountId<SubstrateNetwork.MOONBEAM>, public readonly amount: SCALEInt) {
    super()
  }
}
