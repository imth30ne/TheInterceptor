import { HandleSimulationModeReturnValue, InterceptedRequest, InterceptedRequestForward, PopupMessage, ProviderMessage, Settings, TabState, UserAddressBook } from '../utils/interceptor-messages.js'
import 'webextension-polyfill'
import { Simulator } from '../simulation/simulator.js'
import { EthereumJsonRpcRequest, EthereumQuantity, EthereumUnsignedTransaction, PersonalSignParams, SignTypedDataParams } from '../utils/wire-types.js'
import { changeSimulationMode, clearTabStates, getMakeMeRich, getSettings, getSignerName, getSimulationResults, removeTabState, updateSimulationResults, updateTabState } from './settings.js'
import { blockNumber, call, chainId, estimateGas, gasPrice, getAccounts, getBalance, getBlockByNumber, getCode, getLogs, getPermissions, getSimulationStack, getTransactionByHash, getTransactionCount, getTransactionReceipt, personalSign, requestPermissions, sendTransaction, subscribe, switchEthereumChain, unsubscribe } from './simulationModeHanders.js'
import { changeActiveAddress, changeMakeMeRich, changePage, resetSimulation, confirmDialog, refreshSimulation, removeTransaction, requestAccountsFromSigner, refreshPopupConfirmTransactionSimulation, confirmPersonalSign, confirmRequestAccess, changeInterceptorAccess, changeChainDialog, popupChangeActiveChain, enableSimulationMode, reviewNotification, rejectNotification, addOrModifyAddressInfo, getAddressBookData, removeAddressBookEntry, openAddressBook, homeOpened, interceptorAccessChangeAddressOrRefresh, refreshPopupConfirmTransactionMetadata, refreshPersonalSignMetadata } from './popupMessageHandlers.js'
import { SimulationState } from '../utils/visualizer-types.js'
import { AddressBookEntry, Website, TabConnection, WebsiteSocket, WebsiteTabConnections } from '../utils/user-interface-types.js'
import { requestAccessFromUser } from './windows/interceptorAccess.js'
import { CHAINS, ICON_NOT_ACTIVE, isSupportedChain, MAKE_YOU_RICH_TRANSACTION, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { PriceEstimator } from '../simulation/priceEstimator.js'
import { getActiveAddressForDomain, getAssociatedAddresses, sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts, updateWebsiteApprovalAccesses, verifyAccess } from './accessManagement.js'
import { findAddressInfo, getAddressBookEntriesForVisualiser } from './metadataUtils.js'
import { getActiveAddress, getSocketFromPort, sendPopupMessageToOpenWindows, setExtensionBadgeBackgroundColor, setExtensionIcon, websiteSocketToString } from './backgroundUtils.js'
import { retrieveWebsiteDetails, updateExtensionBadge, updateExtensionIcon } from './iconHandler.js'
import { connectedToSigner, ethAccountsReply, signerChainChanged, walletSwitchEthereumChainReply } from './providerMessageHandlers.js'
import { assertNever, assertUnreachable } from '../utils/typescript.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransaction, copySimulationState, setPrependTransactionsQueue, simulatePersonalSign } from '../simulation/services/SimulationModeEthereumClientService.js'
import { Semaphore } from '../utils/semaphore.js'

const websiteTabConnections = new Map<number, TabConnection>()

browser.runtime.onConnect.addListener(port => onContentScriptConnected(port, websiteTabConnections).catch(console.error))
browser.tabs.onRemoved.addListener((tabId: number) => removeTabState(tabId))

if (browser.runtime.getManifest().manifest_version === 2) {
	clearTabStates()
}

let simulator: Simulator | undefined = undefined

export async function updateSimulationState(getUpdatedSimulationState: () => Promise<SimulationState | undefined>, activeAddress: bigint | undefined) {
	if (simulator === undefined) return
	const simId = (await getSimulationResults()).simulationId + 1
	const updatedSimulationState = await getUpdatedSimulationState()

	if (updatedSimulationState !== undefined) {
		const priceEstimator = new PriceEstimator(simulator.ethereum)

		const transactions = updatedSimulationState.simulatedTransactions.map((x) => ({ transaction: x.signedTransaction, website: x.website }))
		const visualizerResult = await simulator.visualizeTransactionChain(updatedSimulationState, transactions, updatedSimulationState.blockNumber, updatedSimulationState.simulatedTransactions.map((x) => x.multicallResponse))
		const visualizerResultWithWebsites = visualizerResult.map((x, i) => ({ ...x, website: updatedSimulationState.simulatedTransactions[i].website }))
		const addressBookEntries = await getAddressBookEntriesForVisualiser(simulator, visualizerResult.map((x) => x.visualizerResults), updatedSimulationState, (await getSettings()).userAddressBook)

		function onlyTokensAndTokensWithKnownDecimals(metadata: AddressBookEntry) : metadata is AddressBookEntry & { type: 'token', decimals: `0x${ string }` } {
			if (metadata.type !== 'token') return false
			if (metadata.decimals === undefined) return false
			return true
		}
		function metadataRestructure(metadata: AddressBookEntry &  { type: 'token', decimals: bigint } ) {
			return { token: metadata.address, decimals: metadata.decimals }
		}
		const tokenPrices = await priceEstimator.estimateEthereumPricesForTokens(addressBookEntries.filter(onlyTokensAndTokensWithKnownDecimals).map(metadataRestructure))

		await updateSimulationResults({
			simulationId: simId,
			tokenPrices: tokenPrices,
			addressBookEntries: addressBookEntries,
			visualizerResults: visualizerResultWithWebsites,
			simulationState: updatedSimulationState,
			activeAddress: activeAddress,
		})
	} else {
		await updateSimulationResults({
			simulationId: simId,
			addressBookEntries: [],
			tokenPrices: [],
			visualizerResults: [],
			simulationState: updatedSimulationState,
			activeAddress: activeAddress,
		})
	}
	sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed' })
	return updatedSimulationState
}

export function setEthereumNodeBlockPolling(enabled: boolean) {
	if (simulator === undefined) return
	simulator.ethereum.setBlockPolling(enabled)
}

export async function refreshConfirmTransactionSimulation(
	ethereumClientService: EthereumClientService,
	simulationState: SimulationState,
	activeAddress: bigint,
	simulationMode: boolean,
	requestId: number,
	transactionToSimulate: EthereumUnsignedTransaction,
	website: Website,
	userAddressBook: UserAddressBook
) {
	if (simulator === undefined) return undefined

	const priceEstimator = new PriceEstimator(simulator.ethereum)
	sendPopupMessageToOpenWindows({ method: 'popup_confirm_transaction_simulation_started' })
	const newState = await appendTransaction(ethereumClientService, copySimulationState(simulationState), { transaction: transactionToSimulate, website: website })
	const transactions = newState.simulatedTransactions.map(x => ({ transaction: x.signedTransaction, website: x.website }))
	const visualizerResult = await simulator.visualizeTransactionChain(newState, transactions, newState.blockNumber, newState.simulatedTransactions.map(x => x.multicallResponse))
	const addressMetadata = await getAddressBookEntriesForVisualiser(simulator, visualizerResult.map((x) => x.visualizerResults), newState, userAddressBook)
	const tokenPrices = await priceEstimator.estimateEthereumPricesForTokens(
		addressMetadata.map(
			(x) => x.type === 'token' && x.decimals !== undefined ? { token: x.address, decimals: x.decimals } : { token: 0x0n, decimals: 0x0n }
		).filter( (x) => x.token !== 0x0n )
	)

	return {
		method: 'popup_confirm_transaction_simulation_state_changed' as const,
		data: {
			requestId: requestId,
			transactionToSimulate: transactionToSimulate,
			simulationMode: simulationMode,
			simulationState: newState,
			visualizerResults: visualizerResult,
			addressBookEntries: addressMetadata,
			tokenPrices: tokenPrices,
			activeAddress: activeAddress,
			signerName: await getSignerName(),
			website: website,
		}
	}
}

// returns true if simulation state was changed
export async function getPrependTrasactions(ethereumClientService: EthereumClientService, settings: Settings, richMode: boolean) {
	if (!settings.simulationMode || !richMode) return []
	const activeAddress = getActiveAddress(settings)
	const chainId = settings.activeChain.toString()
	if (!isSupportedChain(chainId)) return []
	if (activeAddress === undefined) return []
	return [{
		transaction: {
			from: CHAINS[chainId].eth_donator,
			chainId: CHAINS[chainId].chainId,
			nonce: await ethereumClientService.getTransactionCount(CHAINS[chainId].eth_donator),
			to: activeAddress,
			...MAKE_YOU_RICH_TRANSACTION.transaction,
		},
		website: MAKE_YOU_RICH_TRANSACTION.website
	}]
}

export async function personalSignWithSimulator(params: PersonalSignParams | SignTypedDataParams) {
	return await simulatePersonalSign(params)
}

async function handleSimulationMode(
	simulationState: SimulationState,
	websiteTabConnections: WebsiteTabConnections,
	simulator: Simulator,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest,
	settings: Settings
): Promise<HandleSimulationModeReturnValue> {
	let parsedRequest // separate request parsing and request handling. If there's a parse error, throw that to API user
	try {
		parsedRequest = EthereumJsonRpcRequest.parse(request.options)
	} catch (error) {
		console.warn(request)
		console.warn(error)
		if (error instanceof Error) {
			return {
				error: {
					message: error.message,
					code: 400,
				}
			}
		}
		throw error
	}

	switch (parsedRequest.method) {
		case 'eth_getBlockByNumber': return await getBlockByNumber(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_getBalance': return await getBalance(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_estimateGas': return await estimateGas(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_getTransactionByHash': return await getTransactionByHash(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_getTransactionReceipt': return await getTransactionReceipt(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_sendTransaction': return sendTransaction(websiteTabConnections, getActiveAddressForDomain, simulator.ethereum, parsedRequest, socket, request, true, website, settings)
		case 'eth_call': return await call(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_blockNumber': return await blockNumber(simulator.ethereum, simulationState)
		case 'eth_subscribe': return await subscribe(websiteTabConnections, simulator, socket, parsedRequest)
		case 'eth_unsubscribe': return await unsubscribe(simulator, parsedRequest)
		case 'eth_chainId': return await chainId(simulator)
		case 'net_version': return await chainId(simulator)
		case 'eth_getCode': return await getCode(simulator.ethereum, simulationState, parsedRequest)
		case 'personal_sign':
		case 'eth_signTypedData':
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': return await personalSign(websiteTabConnections, socket, parsedRequest, request, true, website, settings)
		case 'wallet_switchEthereumChain': return await switchEthereumChain(websiteTabConnections, socket, simulator.ethereum, parsedRequest, request, true, website)
		case 'wallet_requestPermissions': return await requestPermissions(websiteTabConnections, getActiveAddressForDomain, socket, settings)
		case 'wallet_getPermissions': return await getPermissions()
		case 'eth_accounts': return await getAccounts(websiteTabConnections, getActiveAddressForDomain, socket, settings)
		case 'eth_requestAccounts': return await getAccounts(websiteTabConnections, getActiveAddressForDomain, socket, settings)
		case 'eth_gasPrice': return await gasPrice(simulator)
		case 'eth_getTransactionCount': return await getTransactionCount(simulator.ethereum, simulationState, parsedRequest)
		case 'interceptor_getSimulationStack': return await getSimulationStack(simulationState, parsedRequest)
		case 'eth_multicall': return { error: { code: 10000, message: 'Cannot call eth_multicall directly' } }
		case 'eth_getStorageAt': return { error: { code: 10000, message: 'eth_getStorageAt not implemented' } }
		case 'eth_getLogs': return await getLogs(simulator.ethereum, simulationState, parsedRequest)
		case 'eth_sign': return { error: { code: 10000, message: 'eth_sign is deprecated' } }
		/*
		Missing methods:
		case 'eth_sendRawTransaction': return
		case 'eth_getProof': return
		case 'eth_getBlockTransactionCountByNumber': return
		case 'eth_getTransactionByBlockHashAndIndex': return
		case 'eth_getTransactionByBlockNumberAndIndex': return
		case 'eth_getBlockReceipts': return
		case 'eth_getStorageAt': return

		case 'eth_getLogs': return
		case 'eth_getFilterChanges': return
		case 'eth_getFilterLogs': return
		case 'eth_newBlockFilter': return
		case 'eth_newFilter': return
		case 'eth_newPendingTransactionFilter': return
		case 'eth_uninstallFilter': return

		case 'eth_protocolVersion': return
		case 'eth_feeHistory': return
		case 'eth_maxPriorityFeePerGas': return
		case 'net_listening': return

		case 'eth_getUncleByBlockHashAndIndex': return
		case 'eth_getUncleByBlockNumberAndIndex': return
		case 'eth_getUncleCountByBlockHash': return
		case 'eth_getUncleCountByBlockNumber': return
		*/
	}
}

async function handleSigningMode(
	ethereumClientService: EthereumClientService,
	socket: WebsiteSocket,
	website: Website,
	request: InterceptedRequest,
	settings: Settings
): Promise<HandleSimulationModeReturnValue> {
	let parsedRequest // separate request parsing and request handling. If there's a parse error, throw that to API user
	try {
		parsedRequest = EthereumJsonRpcRequest.parse(request.options)
	} catch (error) {
		console.warn(request)
		console.warn(error)
		if (error instanceof Error) {
			return {
				error: {
					message: error.message,
					code: 400,
				}
			}
		}
		throw error
	}

	const forwardToSigner = () => ({ forward: true } as const)

	switch (parsedRequest.method) {
		case 'eth_getBlockByNumber':
		case 'eth_getBalance':
		case 'eth_estimateGas':
		case 'eth_getTransactionByHash':
		case 'eth_getTransactionReceipt':
		case 'eth_call':
		case 'eth_blockNumber':
		case 'eth_subscribe':
		case 'eth_unsubscribe':
		case 'eth_chainId':
		case 'net_version':
		case 'eth_getCode':
		case 'wallet_requestPermissions':
		case 'wallet_getPermissions':
		case 'eth_accounts':
		case 'eth_requestAccounts':
		case 'eth_gasPrice':
		case 'eth_getTransactionCount':
		case 'eth_multicall':
		case 'eth_getStorageAt':
		case 'eth_getLogs':
		case 'eth_sign':
		case 'interceptor_getSimulationStack': return forwardToSigner()

		case 'personal_sign':
		case 'eth_signTypedData':
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4': return await personalSign(websiteTabConnections, socket, parsedRequest, request, false, website, settings)
		case 'wallet_switchEthereumChain': return await switchEthereumChain(websiteTabConnections, socket, ethereumClientService, parsedRequest, request, false, website)
		case 'eth_sendTransaction': {
			if (settings && isSupportedChain(settings.activeChain.toString()) ) {
				return sendTransaction(websiteTabConnections, getActiveAddressForDomain, ethereumClientService, parsedRequest, socket, request, false, website, settings)
			}
			return forwardToSigner()
		}
		default: assertUnreachable(parsedRequest)
	}
}

async function newBlockCallback(blockNumber: bigint, ethereumClientService: EthereumClientService) {
	sendPopupMessageToOpenWindows({ method: 'popup_new_block_arrived', data: { blockNumber } })
	refreshSimulation(ethereumClientService, await getSettings())
}

const changeActiveAddressAndChainAndResetSimulationSemaphore = new Semaphore(1)
export async function changeActiveAddressAndChainAndResetSimulation(
	websiteTabConnections: WebsiteTabConnections,
	change: {
		simulationMode: boolean,
		activeAddress?: bigint,
		activeChain?: bigint,
	},
) {
	await changeActiveAddressAndChainAndResetSimulationSemaphore.execute(async () => {
		if (simulator === undefined) return

		if (change.simulationMode) {
			await changeSimulationMode({
				...change,
				...'activeAddress' in change ? { activeSimulationAddress: change.activeAddress } : {}
			})
		} else {
			await changeSimulationMode({
				...change,
				...'activeAddress' in change ? { activeSigningAddress: change.activeAddress } : {}
			})
		}
		const updatedSettings = await getSettings()
		updateWebsiteApprovalAccesses(websiteTabConnections, undefined, updatedSettings)
		sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings })
		if (change.activeChain !== undefined) {
			const chainString = change.activeChain.toString()
			if (isSupportedChain(chainString)) {
				simulator.cleanup()
				simulator = new Simulator(chainString, newBlockCallback)
			}
			sendMessageToApprovedWebsitePorts(websiteTabConnections, 'chainChanged', EthereumQuantity.serialize(change.activeChain))
			sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
		}

		sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })

		if (updatedSettings.simulationMode) {
			// update prepend mode as our active address has changed, so we need to be sure the rich modes money is sent to right address
			const ethereumClientService = simulator.ethereum
			await updateSimulationState(async () => {
				const simulationState = (await getSimulationResults()).simulationState
				const prependQueue = await getPrependTrasactions(ethereumClientService, updatedSettings, await getMakeMeRich())
				return await setPrependTransactionsQueue(ethereumClientService, simulationState, prependQueue)
			}, updatedSettings.activeSimulationAddress)
		}
		// inform website abou this only after we have updated simulation, as they often query the balance right after
		sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, updatedSettings)
	})
}

export async function changeActiveChain(websiteTabConnections: WebsiteTabConnections, chainId: bigint, simulationMode: boolean) {
	if (simulationMode) return await changeActiveAddressAndChainAndResetSimulation(websiteTabConnections, {
		simulationMode: simulationMode,
		activeChain: chainId
	})
	sendMessageToApprovedWebsitePorts(websiteTabConnections, 'request_signer_to_wallet_switchEthereumChain', EthereumQuantity.serialize(chainId))
	await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: await getSettings() })
}

type ProviderHandler = (websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage) => Promise<unknown>
const providerHandlers = new Map<string, ProviderHandler>([
	['eth_accounts_reply', ethAccountsReply],
	['signer_chainChanged', signerChainChanged],
	['wallet_switchEthereumChain_reply', walletSwitchEthereumChainReply],
	['connected_to_signer', connectedToSigner]
])
export function postMessageIfStillConnected(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, message: InterceptedRequestForward) {
	const tabConnection = websiteTabConnections.get(socket.tabId)
	const identifier = websiteSocketToString(socket)
	if (tabConnection === undefined) return false
	for (const [socketAsString, connection] of Object.entries(tabConnection.connections)) {
		if (socketAsString !== identifier) continue
		try {
			connection.port.postMessage(message)
		} catch (error) {
			if (error instanceof Error) {
				if (error.message?.includes('Attempting to use a disconnected port object')) {
					return
				}
				if (error.message?.includes('Could not establish connection. Receiving end does not exist')) {
					return
				}
			}
			throw error
		}
	}
	return true
}

export function sendMessageToContentScript(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, resolved: HandleSimulationModeReturnValue, request: InterceptedRequest) {
	if ('error' in resolved) {
		return postMessageIfStillConnected(websiteTabConnections, socket, {
			...resolved,
			interceptorApproved: false,
			requestId: request.requestId,
			options: request.options
		})
	}
	if (!('forward' in resolved)) {
		return postMessageIfStillConnected(websiteTabConnections, socket, {
			result: resolved.result,
			interceptorApproved: true,
			requestId: request.requestId,
			options: request.options
		})
	}

	return postMessageIfStillConnected(websiteTabConnections, socket, {
		interceptorApproved: true,
		requestId: request.requestId,
		options: request.options
	})
}

export async function handleContentScriptMessage(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest, website: Website) {
	try {
		if (simulator === undefined) throw 'Interceptor not ready'
		const settings = await getSettings()
		if (settings.simulationMode || request.usingInterceptorWithoutSigner) {
			const simulationState = (await getSimulationResults()).simulationState
			if (simulationState === undefined) throw new Error('no simulation state')
			const resolved = await handleSimulationMode(simulationState, websiteTabConnections, simulator, socket, website, request, settings)
			return sendMessageToContentScript(websiteTabConnections, socket, resolved, request)
		}
		const resolved = await handleSigningMode(simulator.ethereum, socket, website, request, settings)
		return sendMessageToContentScript(websiteTabConnections, socket, resolved, request)
	} catch(error) {
		console.warn(error)
		postMessageIfStillConnected(websiteTabConnections, socket, {
			interceptorApproved: false,
			requestId: request.requestId,
			options: request.options,
			error: {
				code: 123456,
				message: 'Unknown error'
			}
		})
		throw error
	}
}

export function refuseAccess(websiteTabConnections: WebsiteTabConnections, socket: WebsiteSocket, request: InterceptedRequest) {
	return postMessageIfStillConnected(websiteTabConnections, socket, {
		interceptorApproved: false,
		requestId: request.requestId,
		options: request.options,
		error: {
			code: METAMASK_ERROR_USER_REJECTED_REQUEST,
			message: 'User refused access to the wallet'
		}
	})
}

export async function gateKeepRequestBehindAccessDialog(socket: WebsiteSocket, request: InterceptedRequest, website: Website, settings: Settings) {
	const activeAddress = getActiveAddress(settings)
	const addressInfo = activeAddress !== undefined ? findAddressInfo(activeAddress, settings.userAddressBook.addressInfos) : undefined
	return await requestAccessFromUser(websiteTabConnections, socket, website, request, addressInfo, getAssociatedAddresses(settings, website.websiteOrigin, addressInfo), settings)
}

async function onContentScriptConnected(port: browser.runtime.Port, websiteTabConnections: WebsiteTabConnections) {
	const socket = getSocketFromPort(port)
	if (port?.sender?.url === undefined) return
	const websiteOrigin = (new URL(port.sender.url)).hostname
	const websitePromise = retrieveWebsiteDetails(port, websiteOrigin)
	const identifier = websiteSocketToString(socket)

	console.log(`content script connected ${ websiteOrigin }`)

	const tabConnection = websiteTabConnections.get(socket.tabId)
	const newConnection = {
		port: port,
		socket: socket,
		websiteOrigin: websiteOrigin,
		approved: false,
		wantsToConnect: false,
	}
	port.onDisconnect.addListener(() => {
		const tabConnection = websiteTabConnections.get(socket.tabId)
		if (tabConnection === undefined) return
		delete tabConnection.connections[websiteSocketToString(socket)]
		if (Object.keys(tabConnection).length === 0) {
			websiteTabConnections.delete(socket.tabId)
		}
	})
	port.onMessage.addListener(async (payload) => {
		if(!(
			'data' in payload
			&& typeof payload.data === 'object'
			&& payload.data !== null
			&& 'interceptorRequest' in payload.data
		)) return
		const request = InterceptedRequest.parse(payload.data)
		const providerHandler = providerHandlers.get(request.options.method)
		if (providerHandler) {
			await providerHandler(websiteTabConnections, port, request)
			return sendMessageToContentScript(websiteTabConnections, socket, { 'result': '0x' }, request)
		}

		const access = verifyAccess(websiteTabConnections, socket, request.options.method, websiteOrigin, await getSettings())

		if (access === 'askAccess' && request.options.method === 'eth_accounts') {
			// do not prompt for eth_accounts, just reply with no accounts.
			return sendMessageToContentScript(websiteTabConnections, socket, { 'result': [] }, request)
		}

		switch (access) {
			case 'noAccess': return refuseAccess(websiteTabConnections, socket, request)
			case 'askAccess': return await gateKeepRequestBehindAccessDialog(socket, request, await websitePromise, await getSettings())
			case 'hasAccess': return await handleContentScriptMessage(websiteTabConnections, socket, request, await websitePromise)
			default: assertNever(access)
		}
	})

	if (tabConnection === undefined) {
		websiteTabConnections.set(socket.tabId, {
			connections: { [identifier]: newConnection },
		})
		await updateTabState(socket.tabId, (previousState: TabState) => {
			return {
				...previousState,
				tabIconDetails: {
					icon: ICON_NOT_ACTIVE,
					iconReason: 'No active address selected.',
				}
			}
		})
		updateExtensionIcon(websiteTabConnections, socket, websiteOrigin)
	} else {
		tabConnection.connections[identifier] = newConnection
	}

}

async function popupMessageHandler(
	websiteTabConnections: WebsiteTabConnections,
	simulator: Simulator,
	request: unknown,
	settings: Settings
) {
	let parsedRequest // separate request parsing and request handling. If there's a parse error, throw that to API user
	try {
		parsedRequest = PopupMessage.parse(request)
	} catch (error) {
		console.warn(request)
		console.warn(error)
		if (error instanceof Error) {
			return {
				error: {
					message: error.message,
					code: 400,
				}
			}
		}
		throw error
	}

	switch (parsedRequest.method) {
		case 'popup_confirmDialog': return await confirmDialog(simulator.ethereum, websiteTabConnections, parsedRequest)
		case 'popup_changeActiveAddress': return await changeActiveAddress(websiteTabConnections, parsedRequest)
		case 'popup_changeMakeMeRich': return await changeMakeMeRich(simulator.ethereum, parsedRequest, settings)
		case 'popup_changePage': return await changePage(parsedRequest)
		case 'popup_requestAccountsFromSigner': return await requestAccountsFromSigner(websiteTabConnections, parsedRequest)
		case 'popup_resetSimulation': return await resetSimulation(simulator.ethereum, settings)
		case 'popup_removeTransaction': return await removeTransaction(simulator.ethereum, parsedRequest, settings)
		case 'popup_refreshSimulation': return await refreshSimulation(simulator.ethereum, settings)
		case 'popup_refreshConfirmTransactionDialogSimulation': return await refreshPopupConfirmTransactionSimulation(simulator.ethereum, parsedRequest)
		case 'popup_refreshConfirmTransactionMetadata': return refreshPopupConfirmTransactionMetadata(simulator, settings.userAddressBook, parsedRequest)
		case 'popup_personalSign': return await confirmPersonalSign(websiteTabConnections, parsedRequest)
		case 'popup_interceptorAccess': return await confirmRequestAccess(websiteTabConnections, parsedRequest)
		case 'popup_changeInterceptorAccess': return await changeInterceptorAccess(websiteTabConnections, parsedRequest)
		case 'popup_changeActiveChain': return await popupChangeActiveChain(websiteTabConnections, parsedRequest, settings)
		case 'popup_changeChainDialog': return await changeChainDialog(websiteTabConnections, parsedRequest)
		case 'popup_enableSimulationMode': return await enableSimulationMode(websiteTabConnections, parsedRequest)
		case 'popup_reviewNotification': return await reviewNotification(websiteTabConnections, parsedRequest, settings)
		case 'popup_rejectNotification': return await rejectNotification(websiteTabConnections, parsedRequest)
		case 'popup_addOrModifyAddressBookEntry': return await addOrModifyAddressInfo(websiteTabConnections, parsedRequest)
		case 'popup_getAddressBookData': return await getAddressBookData(parsedRequest, settings.userAddressBook)
		case 'popup_removeAddressBookEntry': return await removeAddressBookEntry(websiteTabConnections, parsedRequest)
		case 'popup_openAddressBook': return await openAddressBook()
		case 'popup_personalSignReadyAndListening': return // handled elsewhere (personalSign.ts)
		case 'popup_changeChainReadyAndListening': return // handled elsewhere (changeChain.ts)
		case 'popup_interceptorAccessReadyAndListening': return // handled elsewhere (interceptorAccess.ts)
		case 'popup_confirmTransactionReadyAndListening': return // handled elsewhere (confirmTransaction.ts)
		case 'popup_requestNewHomeData': return homeOpened(simulator)
		case 'popup_interceptorAccessChangeAddress': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
		case 'popup_interceptorAccessRefresh': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, parsedRequest)
		case 'popup_refreshPersonalSignMetadata': return await refreshPersonalSignMetadata(parsedRequest, settings)
		default: assertUnreachable(parsedRequest)
	}
}

async function startup() {
	await setExtensionIcon({ path: ICON_NOT_ACTIVE })
	await setExtensionBadgeBackgroundColor({ color: '#58a5b3' })

	const settings = await getSettings()
	const chainString = settings.activeChain.toString()
	simulator = new Simulator(isSupportedChain(chainString) ? chainString : '1', newBlockCallback)

	browser.runtime.onMessage.addListener(async function(message: unknown) {
		if (simulator === undefined) throw new Error('Interceptor not ready yet')
		await popupMessageHandler(websiteTabConnections, simulator, message, await getSettings())
	})

	await updateExtensionBadge()

	if (!settings.simulationMode || settings.useSignersAddressAsActiveAddress) {
		sendMessageToApprovedWebsitePorts(websiteTabConnections, 'request_signer_to_eth_requestAccounts', [])
		sendMessageToApprovedWebsitePorts(websiteTabConnections, 'request_signer_chainId', [])
	}
	if (settings.simulationMode) {
		// update prepend mode as our active address has changed, so we need to be sure the rich modes money is sent to right address
		const ethereumClientService = simulator.ethereum
		await updateSimulationState(async () => {
			const simulationState = (await getSimulationResults()).simulationState
			const prependQueue = await getPrependTrasactions(ethereumClientService, settings, await getMakeMeRich())
			return await setPrependTransactionsQueue(ethereumClientService, simulationState, prependQueue)
		}, settings.activeSimulationAddress)
	}
}

startup()
