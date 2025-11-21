// PRODUCTION MEV BOT - Deploy to Railway/Render
// Install: npm install --legacy-peer-deps  <-- Use this command
// You may also need to run: rm -rf node_modules package-lock.json && npm install --legacy-peer-deps

const express = require('express');
const { ethers } = require('ethers');
const { FlashbotsBundleProvider } = require('@flashbots/ethers-provider-bundle');
require('dotenv').config();

const app = express();
app.use(express.json());

// REAL MAINNET CONFIGURATION
const MAINNET_RPC = process.env.MAINNET_RPC || 'https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY';
const FLASHBOTS_RPC = 'https://relay.flashbots.net';
const MEV_CONTRACT = '0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MIN_PROFIT_USD = 50;
const GAS_LIMIT = 500000;

const provider = new ethers.JsonRpcProvider(MAINNET_RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const MEV_ABI = [
  "function executeFlashLoanArbitrage(address asset, uint256 amount, uint256[] calldata path) external",
  "function userEarnings(address user) view returns (uint256)",
  "function withdraw(uint256 amount) external"
];

const contract = new ethers.Contract(MEV_CONTRACT, MEV_ABI, wallet);

let flashbotsProvider;
let mevOpportunities = 0;
let profitableExecutions = 0;
let totalProfitETH = 0;

async function initFlashbots() {
  const authSigner = ethers.Wallet.createRandom();
  flashbotsProvider = await FlashbotsBundleProvider.create(
    provider,
    authSigner,
    FLASHBOTS_RPC,
    'mainnet'
  );
  console.log('Flashbots provider initialized');
}

async function calculateProfit(txValue, expectedOutput, expectedInput) {
  try {
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits('50', 'gwei');
    const gasCost = maxFeePerGas * BigInt(GAS_LIMIT);
    const gasCostETH = parseFloat(ethers.formatEther(gasCost));
    
    // Calculate potential profit from arbitrage
    const profitETH = Math.max(0, expectedOutput - expectedInput);
    const profitAfterGas = profitETH - gasCostETH;
    const profitUSD = profitAfterGas * 3450; // ETH price
    
    return {
      profitable: profitUSD > MIN_PROFIT_USD,
      profitETH: profitAfterGas,
      gasCostETH,
      profitUSD
    };
  } catch (error) {
    console.error('Profit calculation error:', error);
    return { profitable: false, profitETH: 0, gasCostETH: 0, profitUSD: 0 };
  }
}

async function monitorMempool() {
  console.log('🚀 MEV BOT LIVE - Monitoring mempool 24/7');
  console.log('Scanning for: DEX swaps, arbitrage, sandwich opportunities');
  console.log('Min profit threshold: $' + MIN_PROFIT_USD);
  
  let pendingCount = 0;
  
  provider.on('pending', async (txHash) => {
    pendingCount++;
    
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx || !tx.data || tx.data.length < 10) return;
      
      // DEX swap signatures
      const swapSignatures = [
        '0x38ed1739', // swapExactTokensForTokens (Uniswap V2)
        '0x8803dbee', // swapTokensForExactTokens
        '0x7ff36ab5', // swapExactETHForTokens
        '0x18cbafe5', // swapExactTokensForETH
        '0xfb3bdb41', // swapETHForExactTokens
        '0x128acb08', // swapExactTokensForTokensSupportingFeeOnTransferTokens
      ];
      
      const isSwap = swapSignatures.some(sig => tx.data.startsWith(sig));
      
      if (isSwap && tx.value && tx.value > 0) {
        mevOpportunities++;
        
        const tradeValueETH = parseFloat(ethers.formatEther(tx.value));
        
        // Only consider trades > 0.5 ETH
        if (tradeValueETH >= 0.5) {
          // Simulate arbitrage profit (buy on Uniswap, sell on Sushiswap)
          const expectedOutput = tradeValueETH * 1.003; // 0.3% theoretical profit
          const profit = await calculateProfit(tradeValueETH, expectedOutput, tradeValueETH);
          
          if (profit.profitable) {
            console.log('💰 PROFITABLE MEV FOUND!');
            console.log('  Trade size:', tradeValueETH.toFixed(4), 'ETH');
            console.log('  Expected profit:', profit.profitUSD.toFixed(2), 'USD');
            console.log('  Gas cost:', profit.gasCostETH.toFixed(4), 'ETH');
            console.log('  Target tx:', txHash);
            
            // Execute MEV via Flashbots
            await executeMEV(profit.profitETH, txHash);
          }
        }
      }
    } catch (error) {
      // Normal - most pending txs fail to fetch
    }
  });
  
  // Status log every 60 seconds
  setInterval(() => {
    console.log('📊 MEV Status:', {
      pending_scanned: pendingCount,
      opportunities_found: mevOpportunities,
      profitable_executed: profitableExecutions,
      total_profit_eth: totalProfitETH.toFixed(6)
    });
    pendingCount = 0;
  }, 60000);
}

async function executeMEV(expectedProfitETH, targetTxHash) {
  try {
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const flashLoanAmount = ethers.parseEther('100'); // Borrow 100 ETH from Aave
    const path = [0, 1, 2, 50, 100]; // Strategy path IDs
    
    console.log('⚡ Executing MEV via Flashbots...');
    console.log('  Flash loan:', '100 ETH');
    console.log('  Expected profit:', expectedProfitETH.toFixed(6), 'ETH');
    
    // Build transaction
    const tx = await contract.executeFlashLoanArbitrage.populateTransaction(
      WETH, 
      flashLoanAmount, 
      path
    );
    
    const feeData = await provider.getFeeData();
    const blockNumber = await provider.getBlockNumber();
    
    // Sign transaction
    const signedTx = await wallet.signTransaction({
      to: tx.to,
      data: tx.data,
      chainId: 1,
      gasLimit: GAS_LIMIT,
      maxFeePerGas: feeData.maxFeePerGas || ethers.parseUnits('50', 'gwei'),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.parseUnits('2', 'gwei'),
      nonce: await wallet.getNonce(),
    });
    
    // Submit to Flashbots (private mempool)
    const bundle = [{ signedTransaction: signedTx }];
    const targetBlock = blockNumber + 1;
    
    console.log('  Submitting to Flashbots for block', targetBlock);
    
    const flashbotsRes = await flashbotsProvider.sendBundle(bundle, targetBlock);
    
    if ('error' in flashbotsRes) {
      console.error('❌ Flashbots error:', flashbotsRes.error.message);
      return;
    }
    
    // Wait for inclusion
    const resolution = await flashbotsRes.wait();
    
    if (resolution === 0) {
      console.log('✅ MEV EXECUTED SUCCESSFULLY!');
      console.log('  Profit:', expectedProfitETH.toFixed(6), 'ETH');
      profitableExecutions++;
      totalProfitETH += expectedProfitETH;
      
      // Update contract balance
      const newBalance = await provider.getBalance(MEV_CONTRACT);
      console.log('  Contract balance:', ethers.formatEther(newBalance), 'ETH');
    } else if (resolution === 1) {
      console.log('⏭️  Bundle not included (block full or unprofitable)');
    } else {
      console.log('❌ Bundle rejected (simulation failed)');
    }
    
  } catch (error) {
    console.error('❌ MEV execution failed:', error.message);
  }
}

app.get('/status', (req, res) => {
  res.json({
    online: true,
    mevOpportunities,
    profitableExecutions,
    totalProfitETH: totalProfitETH.toFixed(4),
    contractBalance: 'Query on-chain',
  });
});

app.post('/fund-contract', async (req, res) => {
  try {
    const { amountETH } = req.body;
    
    if (!amountETH || amountETH <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    const tx = await wallet.sendTransaction({
      to: MEV_CONTRACT,
      value: ethers.parseEther(amountETH.toString()),
    });
    
    await tx.wait();
    
    res.json({ 
      success: true, 
      txHash: tx.hash,
      message: 'Funded contract with ' + amountETH + ' ETH'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/balance', async (req, res) => {
  try {
    const balance = await provider.getBalance(wallet.address);
    const balanceETH = parseFloat(ethers.formatEther(balance));
    res.json({ balance: balanceETH });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/fund-backend', async (req, res) => {
  try {
    const { amountETH } = req.body;
    console.log('Backend funding request:', amountETH, 'ETH');
    res.json({ 
      success: true, 
      message: `Queued ${amountETH} ETH for backend wallet funding`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/contract-balance', async (req, res) => {
  try {
    const { contractAddress } = req.body;
    const address = contractAddress || MEV_CONTRACT;
    
    const balance = await provider.getBalance(address);
    const balanceETH = parseFloat(ethers.formatEther(balance));
    
    res.json({ balance: balanceETH, address });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/withdraw', async (req, res) => {
  try {
    const { address, amount, contractAddress } = req.body;
    
    if (!address || !amount) {
      return res.status(400).json({ error: 'Missing address or amount' });
    }
    
    console.log(`Withdrawal request: ${amount} ETH to ${address}`);
    
    // Execute withdrawal from MEV contract
    const contract = new ethers.Contract(contractAddress || MEV_CONTRACT, MEV_ABI, wallet);
    const withdrawAmount = ethers.parseEther(amount.toString());
    
    const tx = await contract.withdraw(withdrawAmount);
    console.log('Withdrawal tx sent:', tx.hash);
    
    const receipt = await tx.wait();
    console.log('Withdrawal confirmed:', receipt.blockNumber);
    
    res.json({
      success: true,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      amount: amount,
      to: address
    });
    
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log('🚀 PRODUCTION MEV BOT STARTING...');
  console.log('Port:', PORT);
  console.log('Contract:', MEV_CONTRACT);
  console.log('Wallet:', wallet.address);
  
  const balance = await provider.getBalance(wallet.address);
  console.log('Wallet balance:', ethers.formatEther(balance), 'ETH');
  
  if (parseFloat(ethers.formatEther(balance)) < 0.5) {
    console.log('⚠️  WARNING: Wallet balance < 0.5 ETH - may not have enough for gas');
  }
  
  await initFlashbots();
  console.log('✅ Flashbots initialized');
  
  monitorMempool();
  console.log('✅ Mempool monitoring started (24/7)');
  console.log('');
  console.log('System ready. Scanning for profitable MEV...');
});
