import { BRAVE_LOGO, METAMASK_LOGO } from '../../utils/constants.js'
import { SignerName } from '../../utils/interceptor-messages.js'

const signerLogos = {
	'MetaMask': METAMASK_LOGO,
	'Brave': BRAVE_LOGO
}

export function getPrettySignerName(signerName: SignerName ) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return 'Unknown signer'
	return signerName
}

export function getSignerLogo(signerName: SignerName ) {
	if (signerName === 'NoSigner' || signerName === 'NotRecognizedSigner' || signerName === 'NoSignerDetected') return undefined
	return signerLogos[signerName]
}

export function SignerLogoText(param: { signerName: SignerName, text: string }) {
	const signerLogo = getSignerLogo(param.signerName)

	return <p style = 'line-height: 24px'>
		{ signerLogo ? <img style = 'width: 24px; height: 24px; vertical-align: bottom; margin-right: 5px' src = { signerLogo }/> : <></>}
		{ param.text }
	</p>
}

export function SignersLogoName(param: { signerName: SignerName}) {
	const signerLogo = getSignerLogo(param.signerName)

	return <span class = 'vertical-center'>
		{ signerLogo ? <img class = 'vertical-center' style = 'width: 24px;' src = { signerLogo }/> : <></> }
		<p class = 'vertical-center'> { getPrettySignerName(param.signerName) } </p>
	</span>
}
