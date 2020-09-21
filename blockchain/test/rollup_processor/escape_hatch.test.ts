import { ethers } from '@nomiclabs/buidler';
import { EthAddress } from 'barretenberg/address';
import { expect, use } from 'chai';
import { solidity } from 'ethereum-waffle';
import { Contract, Signer } from 'ethers';
import { advanceBlocks, blocksToAdvance } from '../fixtures/advance_block';
import { createDepositProof, createEscapeProof, createSecondEscapeProof } from '../fixtures/create_mock_proof';
import { setupRollupProcessor } from '../fixtures/setup_rollup_processor';
import { solidityFormatSignatures } from '../signing/solidity_format_sigs';

use(solidity);

describe('rollup_processor: core', () => {
  let rollupProcessor: Contract;
  let erc20: Contract;
  let userA: Signer;
  let userB: Signer;
  let userAAddress: EthAddress;
  let userBAddress: EthAddress;
  let viewingKeys: Buffer[];

  const provider = ethers.provider;
  const mintAmount = 100;
  const depositAmount = 60;
  const withdrawalAmount = 20;

  beforeEach(async () => {
    [userA, userB] = await ethers.getSigners();
    userAAddress = EthAddress.fromString(await userA.getAddress());
    userBAddress = EthAddress.fromString(await userB.getAddress());
    ({ erc20, rollupProcessor, viewingKeys } = await setupRollupProcessor([userA, userB], mintAmount));

    const { proofData, signatures, sigIndexes } = await createDepositProof(depositAmount, userAAddress, userA);
    await erc20.approve(rollupProcessor.address, depositAmount);
    await rollupProcessor.processRollup(proofData, solidityFormatSignatures(signatures), sigIndexes, viewingKeys);
  });

  it('should process an escape inside valid block window', async () => {
    const initialContractBalance = await erc20.balanceOf(rollupProcessor.address);
    expect(initialContractBalance).to.equal(depositAmount);
    const initialUserBalance = await erc20.balanceOf(userAAddress.toString());

    const { proofData } = await createEscapeProof(withdrawalAmount, userAAddress);
    const nextEscapeBlock = await blocksToAdvance(81, 100, provider);
    await advanceBlocks(nextEscapeBlock, provider);
    await rollupProcessor.processRollup(proofData, [], [], viewingKeys);

    const escapeBlockNum = await rollupProcessor.escapeeBlock(userAAddress.toString());
    expect(escapeBlockNum).to.equal(provider.blockNumber + 1);

    // check balances
    const finalContractBalance = await erc20.balanceOf(rollupProcessor.address);
    expect(finalContractBalance).to.equal(BigInt(initialContractBalance) - BigInt(withdrawalAmount));

    const finalUserBalance = await erc20.balanceOf(userAAddress.toString());
    expect(finalUserBalance).to.equal(BigInt(initialUserBalance) + BigInt(withdrawalAmount));
  });

  it('should reject escape hatch outside valid block window', async () => {
    const { proofData } = await createEscapeProof(withdrawalAmount, userAAddress);
    const escapeBlock = await blocksToAdvance(1, 100, provider);
    await advanceBlocks(escapeBlock, provider);
    await expect(rollupProcessor.processRollup(proofData, [], [], viewingKeys)).to.be.revertedWith(
      'Rollup Processor: ESCAPE_BLOCK_RANGE_INCORRECT',
    );
  });

  it('should reject same user escaping within rate limit', async () => {
    const { proofData } = await createEscapeProof(withdrawalAmount, userAAddress);
    const nextEscapeBlock = await blocksToAdvance(81, 100, provider);
    await advanceBlocks(nextEscapeBlock, provider);
    await rollupProcessor.processRollup(proofData, [], [], viewingKeys);

    const { proofData: secondProofData } = await createSecondEscapeProof(withdrawalAmount, userAAddress);
    await expect(rollupProcessor.processRollup(secondProofData, [], [], viewingKeys)).to.be.revertedWith(
      'Rollup Processor: ESCAPE_LIMIT',
    );
  });
});