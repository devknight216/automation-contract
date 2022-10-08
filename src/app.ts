import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as cron from 'node-cron';
const mongoose = require('mongoose');
mongoose.connect('mongodb://localhost:27017/claim_lists');

import lists from './models';

// const ContractFactory = require('./BNBP.json');
import * as contractAbi from './tokenAbi.json'
dotenv.config();

const dailyBudget = 0.0005;// ETH amount
const claimBudget = 0.001;// ETH amount
const contractAddr = '0xFbbfEf10b6b4E8951176ED9b604C66448Ce49784';
const fundAddress = '0x276c6F85BaCf73463c552Db4fC5Cb6ecAC682309';
const holderAddress = '0x276c6F85BaCf73463c552Db4fC5Cb6ecAC682309';// Address of client for all token collection.
const fundPrivateKey = '0499e866b816b1abd4da79d03295a41760a6348bc610214f8edc427d331fa9b6';
const network = 'goerli';
const gasFee = 0;//Gas units (limit) * Gas price per unit (in gwei) = Gas fee
const customWsProvider = ethers.getDefaultProvider(network);


let nextDay = Math.floor(+new Date() / 1000 / (3600 * 24));
let claimFlag = false;

let fundWallet = {
	address: fundAddress,
	privateKey: fundPrivateKey
};

const CreateRandomWallet = async () => {
	let wallet = ethers.Wallet.createRandom();
	// let randomMnemonic = wallet.mnemonic;
	return wallet;
}

const EthBalanceOf = async (address: any) => {
	// const provider = new ethers.providers.JsonRpcProvider(providerUrl)
	let provider = ethers.getDefaultProvider(network);
	let balance = await provider.getBalance(address);
	return balance;
}

const Fund = async (previousWallet: any, nextWallet: any, value: any) => {
	const wallet = new ethers.Wallet(previousWallet.privateKey, customWsProvider)
	console.log(value)
	const gasPrice = await customWsProvider.getGasPrice()
	const estimateGas = await customWsProvider.estimateGas({
		to: nextWallet.address,
		value: value
	})
	console.log(Number(gasPrice));
	const estimateTxFee = (gasPrice.add(10)).mul(estimateGas)
	console.log(Number(estimateTxFee))
	let maxValue = value.sub(estimateTxFee);
	console.log("fund:" + previousWallet.address + "--->" + nextWallet.address + ":" + maxValue + "fee:" + estimateTxFee)
	// ethers.utils.parseEther(amountInEther)
	const tx = {
		to: nextWallet.address,
		value: maxValue
	}
	const txResult: any = await wallet.sendTransaction(tx)
	const result = await txResult.wait();
	console.log("fund status:" + result.status);
}

const claimReward = async () => {
	claimFlag = true;
	try {
		const currentTime = Math.floor(+new Date() / 1000);
		const result = await lists.find({
			claimTime: { $gt: currentTime, $lt: 0 },
		});
		if (result.length) {
			console.log("claim possible addresses: " + result);
			let previousWallet = fundWallet;
			let nextWallet = { address: result[0].address, privateKey: result[0].privateKey };
			await Fund(previousWallet, nextWallet, claimBudget)
			result.map(async (item: any, idx: number) => {
				const signer = new ethers.Wallet(item.privateKey, customWsProvider);
				const tokenContract = new ethers.Contract(contractAddr, contractAbi, signer)
				const tx = await tokenContract.claimMintReward();
				const receipt = await tx.wait();
				if (receipt.status === 1) {
					const amount = await tokenContract.balanceOf(holderAddress);
					const tx = await tokenContract.transfer(holderAddress, amount)
					const receipt = await tx.wait();
					if (receipt.status === 1) {
						const result = await lists.deleteOne({
							address: item.address
						});
						console.log(item.address + " claim ended.")
					}
				}
				const value = await EthBalanceOf(item.address)
				if (idx < result.length) {
					nextWallet = {
						address: result[idx + 1].address,
						privateKey: result[idx + 1].privateKey,
					}
				}
				else {
					nextWallet = fundWallet;
				}
				previousWallet = {
					address: item.address,
					privateKey: item.privateKey,
				}
				await Fund(previousWallet, nextWallet, value)
			})
		}
	} catch (error) {
		console.log('claimReward error : ')
	}
	claimFlag = false;
};

const claimMint = async (wallet: any) => {
	console.log('start')
	console.log(await EthBalanceOf(wallet.address))
	const signer = new ethers.Wallet(wallet.privateKey, customWsProvider);

	const tokenContract = new ethers.Contract(contractAddr, contractAbi, signer)
	const maxTerm = await tokenContract.getCurrentMaxTerm();
	const dayTerm = Math.floor(maxTerm / 86400)
	const sundayDiffDay = (dayTerm + new Date().getDay()) % 7;
	const term = dayTerm - sundayDiffDay;
	console.log("term:" + term)
	const tx = await tokenContract.claimRank(term);
	const receipt = await tx.wait();

	if (receipt && receipt.blockNumber && receipt.status === 1) { // 0 - failed, 1 - success
		console.log(`Transaction mined, status success`);
		// Save account to MongoDB
		const newLog = {
			address: wallet.address,
			privateKey: wallet.privateKey,
			time: Math.floor(+new Date() / 1000),
			claimTime: Math.floor(+new Date() / 1000) + Number(term * 86400)
		}
		let NewObject: any = new lists(newLog);
		let saveResult = await NewObject.save();
		if (saveResult && saveResult != null || saveResult !== '') {
			console.log('Save DB')
		}

	} else if (receipt && receipt.blockNumber && receipt.status === 0) {
		console.log(`Transaction mined, status failed`);
	} else {
		console.log(`Transaction not mined`);
	}
}

const dailyStart = async () => {
	console.log('Hello. let`s go to auto-mint');
	const today = Math.floor(+new Date() / 1000 / (3600 * 24));
	nextDay = today + 1;
	let randomWallet = await CreateRandomWallet();
	let previousWallet = {
		address: randomWallet.address,
		privateKey: randomWallet.privateKey
	}
	try {
		await Fund(fundWallet, previousWallet, ethers.utils.parseEther(dailyBudget.toString()))
		await claimMint(previousWallet);
	} catch (error) {
		console.log("today's fund is all spent");
		//break;
	}
	for (; ;) {//infinite loop
		let nextWallet = await CreateRandomWallet()
		try {
			const value = await EthBalanceOf(previousWallet.address)
			await Fund(previousWallet, nextWallet, value)
			await claimMint(nextWallet);
			previousWallet = {
				address: nextWallet.address,
				privateKey: nextWallet.privateKey
			}
		} catch (error) {
			console.error(error);
			const value = await EthBalanceOf(nextWallet.address)
			await Fund(nextWallet, fundWallet, value);
			console.log("today's fund is all spent-----------------------");
			break;
		}
	}
};

const main = async () => {
	console.log(gasFee)
	cron.schedule("*/5 * * * * *", async () => {
		const today = Math.floor(+new Date() / 1000 / (3600 * 24));
		if (today == nextDay) {
			dailyStart();
		}
	})
	cron.schedule("*/5 * * * * *", async () => {
		if (!claimFlag) claimReward()
	})
}
//main();
// .then(() => {
// 	console.log('finished');
// })
// .catch((error) => {
// 	console.log(error);
// });
const testWallet1 = {
	address: "0x1b99F8446520D5709CfE4d544C8173a14983E57e",
	privateKey: "c1f7b5c9b72f7fb874c82dde89e2bdcd158f0e11912f3336fd8c402ac55be63a"
}
const testWallet2 = {
	address: "0x14d34eCD4280C85F32319f95D9c8bfEF5776A002",
	privateKey: "a9f80d5ca6eabc3e319589d09b9a09ac0d588ab0814b3256a2917db067fe7542"
}
const test = async () => {
	const value = await EthBalanceOf(testWallet1.address);
	console.log(ethers.utils.formatUnits(value))
	await Fund(testWallet1, testWallet2, ethers.utils.parseEther("0.001"));
}

test()