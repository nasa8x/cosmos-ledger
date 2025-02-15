import App from 'ledger-cosmos-js'
import { getCosmosAddress } from '@lunie/cosmos-keys'
import { signatureImport } from 'secp256k1'
import TransportU2F from '@ledgerhq/hw-transport-u2f'
const semver = require('semver')

const INTERACTION_TIMEOUT = 120 // seconds to wait for user action on Ledger, currently is always limited to 60
const REQUIRED_COSMOS_APP_VERSION = '1.5.0'
//const REQUIRED_LEDGER_FIRMWARE = "1.1.1"

declare global {
  interface Window {
    chrome: any
    opr: any
  }
}

/*
HD wallet derivation path (BIP44)
DerivationPath{44, 118, account, 0, index}
*/
const HDPATH = [44, 118, 0, 0, 0]
const BECH32PREFIX = `cosmos`

export default class Ledger {
  private readonly testModeAllowed: Boolean
  private cosmosApp: any

  constructor({ testModeAllowed = false }: { testModeAllowed: Boolean }) {
    this.testModeAllowed = testModeAllowed
  }

  // quickly test connection and compatibility with the Ledger device throwing away the connection
  async testDevice() {
    // poll device with low timeout to check if the device is connected
    const secondsTimeout = 3 // a lower value always timeouts
    await this.connect(secondsTimeout)
    this.cosmosApp = null

    return this
  }

  // check if the connection we established with the Ledger device is working
  private async isSendingData() {
    // check if the device is connected or on screensaver mode
    const response = await this.cosmosApp.publicKey(HDPATH)
    this.checkLedgerErrors(response, {
      timeoutMessag: 'Could not find a connected and unlocked Ledger device'
    })
  }

  // check if the Ledger device is ready to receive signing requests
  private async isReady() {
    // check if the version is supported
    const version = await this.getCosmosAppVersion()

    if (!semver.gte(version, REQUIRED_COSMOS_APP_VERSION)) {
      const msg = `Outdated version: Please update Ledger Cosmos App to the latest version.`
      throw new Error(msg)
    }

    // throws if not open
    await this.isCosmosAppOpen()
  }

  // connects to the device and checks for compatibility
  // the timeout is the time the user has to react to requests on the Ledger device
  // set a low timeout to only check the connection without preparing the connection for user input
  async connect(timeout = INTERACTION_TIMEOUT) {
    // assume well connection if connected once
    if (this.cosmosApp) return this

    let transport = await TransportU2F.create(timeout * 1000)

    const cosmosLedgerApp = new App(transport)

    this.cosmosApp = cosmosLedgerApp

    await this.isSendingData()
    await this.isReady()

    return this
  }

  // returns the cosmos app version as a string like "1.1.0"
  async getCosmosAppVersion() {
    await this.connect()

    const response = await this.cosmosApp.getVersion()
    this.checkLedgerErrors(response)
    const { major, minor, patch, test_mode } = response
    checkAppMode(this.testModeAllowed, test_mode)
    const version = versionString({ major, minor, patch })

    return version
  }

  // checks if the cosmos app is open
  // to be used for a nicer UX
  async isCosmosAppOpen() {
    await this.connect()

    const response = await this.cosmosApp.appInfo()
    this.checkLedgerErrors(response)
    const { appName } = response

    if (appName.toLowerCase() !== `cosmos`) {
      throw new Error(`Close ${appName} and open the Cosmos app`)
    }
  }

  // returns the public key from the Ledger device as a Buffer
  async getPubKey() {
    await this.connect()

    const response = await this.cosmosApp.publicKey(HDPATH)
    this.checkLedgerErrors(response)
    return response.compressed_pk
  }

  // returns the cosmos address from the Ledger as a string
  async getCosmosAddress() {
    await this.connect()

    const pubKey = await this.getPubKey()
    return getCosmosAddress(pubKey)
  }

  // triggers a confirmation request of the cosmos address on the Ledger device
  async confirmLedgerAddress() {
    await this.connect()
    const cosmosAppVersion = await this.getCosmosAppVersion()

    if (semver.lt(cosmosAppVersion, REQUIRED_COSMOS_APP_VERSION)) {
      // we can't check the address on an old cosmos app
      return
    }

    const response = await this.cosmosApp.getAddressAndPubKey(HDPATH, BECH32PREFIX)
    this.checkLedgerErrors(response, {
      rejectionMessage: 'Displayed address was rejected'
    })
  }

  // create a signature for any message
  // in Cosmos this should be a serialized StdSignMsg
  // this is ideally generated by the @lunie/cosmos-js library
  async sign(signMessage: string) {
    await this.connect()

    const response = await this.cosmosApp.sign(HDPATH, signMessage)
    this.checkLedgerErrors(response)
    // we have to parse the signature from Ledger as it's in DER format
    const parsedSignature = signatureImport(response.signature)
    return parsedSignature
  }

  // parse Ledger errors in a more user friendly format
  /* istanbul ignore next: maps a bunch of errors */
  private checkLedgerErrors(
    { error_message, device_locked }: { error_message: string; device_locked: Boolean },
    {
      timeoutMessag = 'Connection timed out. Please try again.',
      rejectionMessage = 'User rejected the transaction'
    } = {}
  ) {
    if (device_locked) {
      throw new Error(`Ledger's screensaver mode is on`)
    }
    switch (error_message) {
      case `U2F: Timeout`:
        throw new Error(timeoutMessag)
      case `Cosmos app does not seem to be open`:
        throw new Error(`Cosmos app is not open`)
      case `Command not allowed`:
        throw new Error(`Transaction rejected`)
      case `Transaction rejected`:
        throw new Error(rejectionMessage)
      case `Unknown Status Code: 26628`:
        throw new Error(`Ledger's screensaver mode is on`)
      case `Instruction not supported`:
        throw new Error(
          `Your Cosmos Ledger App is not up to date. ` +
            `Please update to version ${REQUIRED_COSMOS_APP_VERSION}.`
        )
      case `No errors`:
        // do nothing
        break
      default:
        throw new Error(error_message)
    }
  }
}

// stiched version string from Ledger app version object
function versionString({ major, minor, patch }: { major: Number; minor: Number; patch: Number }) {
  return `${major}.${minor}.${patch}`
}

// wrapper to throw if app is in testmode but it is not allowed to be in testmode
export const checkAppMode = (testModeAllowed: Boolean, testMode: Boolean) => {
  if (testMode && !testModeAllowed) {
    throw new Error(
      `DANGER: The Cosmos Ledger app is in test mode and shouldn't be used on mainnet!`
    )
  }
}
