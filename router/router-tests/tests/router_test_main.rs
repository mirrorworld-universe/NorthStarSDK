use anchor_lang::{AccountDeserialize, AnchorDeserialize, InstructionData, ToAccountMetas};
use solana_program_test::*;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use std::num::NonZero;
use std::str::FromStr;

// Import router program
use router::{
    state::{FeeVault, Outbox, Session},
    types::{EmbeddedOpcode, EmbeddedParams, SerializableAccountMeta, SonicMsg, SonicMsgInner},
};

const PROGRAM_ID: &str = "J6YB6HFjFecHKRvgfWwqa6sAr2DhR2k7ArvAd6NG7mBo";

// ============================================================================
// Helper Functions
// ============================================================================

/// 创建程序测试实例
fn create_program_test() -> ProgramTest {
    let program_id = Pubkey::from_str(PROGRAM_ID).unwrap();
    let mut pt = ProgramTest::default();
    pt.add_program("router", program_id, processor!(process_instruction));
    pt
}

/// 处理指令的入口函数
fn process_instruction(
    program_id: &Pubkey,
    accounts: &[solana_sdk::account_info::AccountInfo],
    instruction_data: &[u8],
) -> Result<(), anchor_lang::prelude::ProgramError> {
    let accounts = unsafe { std::slice::from_raw_parts(accounts.as_ptr(), accounts.len()) };
    router::entry(program_id, accounts, instruction_data)
}

/// 派生 Session PDA
fn derive_session_pda(program_id: &Pubkey, owner: &Pubkey, grid_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"session", owner.as_ref(), &grid_id.to_le_bytes()],
        program_id,
    )
}

/// 派生 FeeVault PDA
fn derive_fee_vault_pda(program_id: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"fee_vault", owner.as_ref()], program_id)
}

/// 派生 Outbox PDA
fn derive_outbox_pda(program_id: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"outbox", owner.as_ref()], program_id)
}

// ============================================================================
// Basic Tests - 基础功能测试
// ============================================================================

/// 测试多个账户创建
#[tokio::test]
async fn test_multiple_accounts() {
    println!("测试多个账户创建...");

    let program_test = ProgramTest::default();
    let (mut banks_client, payer, recent_blockhash) = program_test.start().await;

    // 创建多个测试账户
    let num_accounts = 5;
    let mut accounts = Vec::new();

    for i in 0..num_accounts {
        let keypair = Keypair::new();
        let lamports = 1_000_000_000; // 1 SOL

        let transfer_ix =
            solana_sdk::system_instruction::transfer(&payer.pubkey(), &keypair.pubkey(), lamports);

        let mut transaction = Transaction::new_with_payer(&[transfer_ix], Some(&payer.pubkey()));
        transaction.sign(&[&payer], recent_blockhash);

        banks_client.process_transaction(transaction).await.unwrap();

        let balance = banks_client.get_balance(keypair.pubkey()).await.unwrap();

        println!(
            "  账户 {}: {} - 余额: {} lamports",
            i,
            keypair.pubkey(),
            balance
        );

        assert_eq!(balance, lamports);
        accounts.push(keypair);
    }

    println!("\n成功创建 {} 个账户！", num_accounts);
}

/// 测试 Clock 和 Rent sysvar
#[tokio::test]
async fn test_clock_and_rent() {
    println!("测试 Clock 和 Rent sysvars...");

    let program_test = ProgramTest::default();
    let (mut banks_client, _payer, _recent_blockhash) = program_test.start().await;

    // 获取 Clock sysvar
    let clock = banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    println!("Clock:");
    println!("  - Slot: {}", clock.slot);
    println!("  - Epoch: {}", clock.epoch);
    println!("  - Unix timestamp: {}", clock.unix_timestamp);

    // 获取 Rent sysvar
    let rent = banks_client.get_rent().await.unwrap();
    println!("\nRent:");
    println!(
        "  - Lamports per byte year: {}",
        rent.lamports_per_byte_year
    );
    println!("  - Exemption threshold: {}", rent.exemption_threshold);

    // 计算不同大小的租金豁免
    let sizes = [0, 100, 1000, 10000];
    println!("\n不同大小的租金豁免:");
    for size in sizes {
        let min_balance = rent.minimum_balance(size);
        println!("  - {} bytes: {} lamports", size, min_balance);
    }

    println!("\nSysvar 测试完成！");
}

// ============================================================================
// Router Program Tests - Router 程序功能测试
// ============================================================================

/// 测试 OpenSession - 打开会话
#[tokio::test]
async fn test_open_session() {
    println!("测试 OpenSession...");

    let program_id = Pubkey::from_str(PROGRAM_ID).unwrap();
    let program_test = create_program_test();
    let (mut banks_client, payer, _recent_blockhash) = program_test.start().await;

    let grid_id = 1u64;
    let (session_pda, _session_bump) = derive_session_pda(&program_id, &payer.pubkey(), grid_id);
    let (fee_vault_pda, _fee_vault_bump) = derive_fee_vault_pda(&program_id, &payer.pubkey());

    println!("📝 创建会话:");
    println!("  - Session PDA: {}", session_pda);
    println!("  - FeeVault PDA: {}", fee_vault_pda);

    // 构建 OpenSession 指令
    let instruction_data = router::instruction::OpenSession {
        grid_id,
        allowed_programs: vec![],
        allowed_opcodes: vec![EmbeddedOpcode::Swap],
        ttl_slots: NonZero::new(2000).unwrap(),
        fee_cap: NonZero::new(1_000_000).unwrap(),
    }
    .data();

    let open_session_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(session_pda, false),
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: instruction_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[open_session_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);

    match banks_client.process_transaction(transaction).await {
        Ok(_) => {
            println!("✅ 会话创建成功");

            // 验证 Session 账户
            let session_account = banks_client
                .get_account(session_pda)
                .await
                .unwrap()
                .unwrap();

            println!("Session 账户:");
            println!("  - Owner: {}", session_account.owner);
            println!("  - Data length: {}", session_account.data.len());
            println!("  - Lamports: {}", session_account.lamports);

            assert_eq!(session_account.owner, program_id);

            // 验证 FeeVault 账户
            let fee_vault_account = banks_client
                .get_account(fee_vault_pda)
                .await
                .unwrap()
                .unwrap();

            println!("\nFeeVault 账户:");
            println!("  - Owner: {}", fee_vault_account.owner);
            println!("  - Data length: {}", fee_vault_account.data.len());
            println!("  - Lamports: {}", fee_vault_account.lamports);

            assert_eq!(fee_vault_account.owner, program_id);
        }
        Err(e) => {
            println!("❌ 会话创建失败: {:?}", e);
            panic!("OpenSession 失败");
        }
    }

    println!("OpenSession 测试完成！");
}

/// 测试 DepositFee - 存入费用
#[tokio::test]
async fn test_deposit_fee() {
    println!("测试 DepositFee...");

    let program_id = Pubkey::from_str(PROGRAM_ID).unwrap();
    let program_test = create_program_test();
    let (mut banks_client, payer, _recent_blockhash) = program_test.start().await;

    let grid_id = 1u64;
    let (session_pda, _) = derive_session_pda(&program_id, &payer.pubkey(), grid_id);
    let (fee_vault_pda, _) = derive_fee_vault_pda(&program_id, &payer.pubkey());

    // 1. 先创建会话
    println!("步骤 1: 创建会话...");
    let open_session_data = router::instruction::OpenSession {
        grid_id,
        allowed_programs: vec![],
        allowed_opcodes: vec![EmbeddedOpcode::Swap],
        ttl_slots: NonZero::new(2000).unwrap(),
        fee_cap: NonZero::new(1_000_000).unwrap(),
    }
    .data();

    let open_session_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(session_pda, false),
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: open_session_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[open_session_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    println!("✅ 会话已创建");

    // 2. 存入费用
    println!("\n步骤 2: 存入费用...");
    let deposit_amount = 500_000u64;

    let deposit_fee_data = router::instruction::DepositFee {
        amount: deposit_amount,
    }
    .data();

    let deposit_fee_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: deposit_fee_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[deposit_fee_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);

    match banks_client.process_transaction(transaction).await {
        Ok(_) => {
            println!("✅ 费用存入成功");

            // 验证 FeeVault 余额
            let fee_vault_account = banks_client
                .get_account(fee_vault_pda)
                .await
                .unwrap()
                .unwrap();

            let fee_vault =
                FeeVault::try_deserialize(&mut fee_vault_account.data.as_slice()).unwrap();

            println!("\nFeeVault 状态:");
            println!("  - Balance: {} lamports", fee_vault.balance);
            println!("  - Authority: {}", fee_vault.authority);

            assert_eq!(fee_vault.balance, deposit_amount);
        }
        Err(e) => {
            println!("❌ 费用存入失败: {:?}", e);
            panic!("DepositFee 失败");
        }
    }

    println!("DepositFee 测试完成！");
}

/// 测试完整流程: OpenSession -> DepositFee -> SendMessage
#[tokio::test]
async fn test_full_flow() {
    println!("测试完整流程: OpenSession -> DepositFee -> SendMessage");

    let program_id = Pubkey::from_str(PROGRAM_ID).unwrap();
    let program_test = create_program_test();
    let (mut banks_client, payer, _recent_blockhash) = program_test.start().await;

    let grid_id = 1u64;
    let (session_pda, _) = derive_session_pda(&program_id, &payer.pubkey(), grid_id);
    let (fee_vault_pda, _) = derive_fee_vault_pda(&program_id, &payer.pubkey());
    let (outbox_pda, _) = derive_outbox_pda(&program_id, &payer.pubkey());

    // === 步骤 1: 创建会话 ===
    println!("\n步骤 1: 创建会话...");
    let open_session_data = router::instruction::OpenSession {
        grid_id,
        allowed_programs: vec![system_program::id()], // 允许系统程序
        allowed_opcodes: vec![EmbeddedOpcode::Swap],
        ttl_slots: NonZero::new(2000).unwrap(),
        fee_cap: NonZero::new(1_000_000).unwrap(),
    }
    .data();

    let open_session_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(session_pda, false),
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: open_session_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[open_session_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();
    println!("✅ 会话已创建");

    // === 步骤 2: 存入费用 ===
    println!("\n步骤 2: 存入费用...");
    let deposit_amount = 500_000u64;

    let deposit_fee_data = router::instruction::DepositFee {
        amount: deposit_amount,
    }
    .data();

    let deposit_fee_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: deposit_fee_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[deposit_fee_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();
    println!("✅ 费用已存入");

    // === 步骤 3: 发送消息 ===
    println!("\n步骤 3: 发送消息...");

    // 构建 Sonic 消息
    let sonic_msg = SonicMsg {
        grid_id,
        nonce: 0,
        ttl_slots: 1000,
        inner: SonicMsgInner::InvokeCall {
            target_program: system_program::id(),
            accounts: vec![],
            data: vec![],
        },
    };

    let fee_budget = 100_000u64;

    let send_message_data = router::instruction::SendMessage {
        grid_id,
        msg: sonic_msg.clone(),
        fee_budget,
    }
    .data();

    let send_message_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(outbox_pda, false),
            AccountMeta::new(session_pda, false),
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: send_message_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[send_message_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);

    match banks_client.process_transaction(transaction).await {
        Ok(_) => {
            println!("✅ 消息发送成功");

            // 验证 Outbox
            let outbox_account = banks_client
                .get_account(outbox_pda)
                .await
                .unwrap()
                .unwrap();

            let outbox = Outbox::try_deserialize(&mut outbox_account.data.as_slice()).unwrap();

            println!("\nOutbox 状态:");
            println!("  - Authority: {}", outbox.authority);
            println!("  - Entry count: {}", outbox.entry_count);

            assert_eq!(outbox.authority, payer.pubkey());
            assert_eq!(outbox.entry_count, 1);

            // 验证 Session nonce 已递增
            let session_account = banks_client
                .get_account(session_pda)
                .await
                .unwrap()
                .unwrap();

            let session = Session::try_deserialize(&mut session_account.data.as_slice()).unwrap();

            println!("\nSession 状态:");
            println!("  - Nonce: {}", session.nonce);
            assert_eq!(session.nonce, 1);

            // 验证 FeeVault 余额已扣除
            let fee_vault_account = banks_client
                .get_account(fee_vault_pda)
                .await
                .unwrap()
                .unwrap();

            let fee_vault =
                FeeVault::try_deserialize(&mut fee_vault_account.data.as_slice()).unwrap();

            println!("\nFeeVault 状态:");
            println!("  - Balance: {} lamports", fee_vault.balance);
            assert_eq!(fee_vault.balance, deposit_amount - fee_budget);
        }
        Err(e) => {
            println!("❌ 消息发送失败: {:?}", e);
            panic!("SendMessage 失败");
        }
    }

    println!("\n完整流程测试完成！");
}

/// 测试多次发送消息
#[tokio::test]
async fn test_multiple_sends() {
    println!("测试多次发送消息...");

    let program_id = Pubkey::from_str(PROGRAM_ID).unwrap();
    let program_test = create_program_test();
    let (mut banks_client, payer, _recent_blockhash) = program_test.start().await;

    let grid_id = 1u64;
    let (session_pda, _) = derive_session_pda(&program_id, &payer.pubkey(), grid_id);
    let (fee_vault_pda, _) = derive_fee_vault_pda(&program_id, &payer.pubkey());
    let (outbox_pda, _) = derive_outbox_pda(&program_id, &payer.pubkey());

    // 设置会话
    let open_session_data = router::instruction::OpenSession {
        grid_id,
        allowed_programs: vec![],
        allowed_opcodes: vec![EmbeddedOpcode::Swap],
        ttl_slots: NonZero::new(2000).unwrap(),
        fee_cap: NonZero::new(1_000_000).unwrap(),
    }
    .data();

    let open_session_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(session_pda, false),
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: open_session_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[open_session_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    // 存入足够的费用
    let deposit_amount = 1_000_000u64;
    let deposit_fee_data = router::instruction::DepositFee {
        amount: deposit_amount,
    }
    .data();

    let deposit_fee_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: deposit_fee_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[deposit_fee_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    // 发送多条消息
    let num_messages = 5;
    let fee_budget = 50_000u64;

    for i in 0..num_messages {
        println!("\n发送消息 {}...", i + 1);

        let sonic_msg = SonicMsg {
            grid_id,
            nonce: i as u128,
            ttl_slots: 1000,
            inner: SonicMsgInner::EmbeddedOpcode {
                opcode: EmbeddedOpcode::Swap,
                params: EmbeddedParams {
                    in_mint: Pubkey::new_unique(),
                    out_mint: Pubkey::new_unique(),
                    amount_in: 1000,
                    slippage_bps: 50,
                    deadline_slot: 10000,
                    expected_plan_hash: [0u8; 32],
                },
            },
        };

        let send_message_data = router::instruction::SendMessage {
            grid_id,
            msg: sonic_msg,
            fee_budget,
        }
        .data();

        let send_message_ix = Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(outbox_pda, false),
                AccountMeta::new(session_pda, false),
                AccountMeta::new(fee_vault_pda, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data: send_message_data,
        };

        let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
        let mut transaction =
            Transaction::new_with_payer(&[send_message_ix], Some(&payer.pubkey()));
        transaction.sign(&[&payer], recent_blockhash);

        banks_client.process_transaction(transaction).await.unwrap();
        println!("✅ 消息 {} 发送成功", i + 1);
    }

    // 验证最终状态
    let outbox_account = banks_client
        .get_account(outbox_pda)
        .await
        .unwrap()
        .unwrap();
    let outbox = Outbox::try_deserialize(&mut outbox_account.data.as_slice()).unwrap();

    println!("\n最终 Outbox 状态:");
    println!("  - Entry count: {}", outbox.entry_count);
    assert_eq!(outbox.entry_count, num_messages);

    let session_account = banks_client
        .get_account(session_pda)
        .await
        .unwrap()
        .unwrap();
    let session = Session::try_deserialize(&mut session_account.data.as_slice()).unwrap();

    println!("\n最终 Session 状态:");
    println!("  - Nonce: {}", session.nonce);
    assert_eq!(session.nonce, num_messages as u128);

    let fee_vault_account = banks_client
        .get_account(fee_vault_pda)
        .await
        .unwrap()
        .unwrap();
    let fee_vault = FeeVault::try_deserialize(&mut fee_vault_account.data.as_slice()).unwrap();

    println!("\n最终 FeeVault 状态:");
    println!("  - Balance: {} lamports", fee_vault.balance);
    assert_eq!(
        fee_vault.balance,
        deposit_amount - (fee_budget * num_messages)
    );

    println!("\n多次发送消息测试完成！");
}

// ============================================================================
// Negative Tests - 错误情况测试
// ============================================================================

/// 测试余额不足的情况
#[tokio::test]
async fn test_insufficient_balance() {
    println!("测试余额不足...");

    let program_id = Pubkey::from_str(PROGRAM_ID).unwrap();
    let program_test = create_program_test();
    let (mut banks_client, payer, _recent_blockhash) = program_test.start().await;

    let grid_id = 1u64;
    let (session_pda, _) = derive_session_pda(&program_id, &payer.pubkey(), grid_id);
    let (fee_vault_pda, _) = derive_fee_vault_pda(&program_id, &payer.pubkey());
    let (outbox_pda, _) = derive_outbox_pda(&program_id, &payer.pubkey());

    // 创建会话
    let open_session_data = router::instruction::OpenSession {
        grid_id,
        allowed_programs: vec![],
        allowed_opcodes: vec![EmbeddedOpcode::Swap],
        ttl_slots: NonZero::new(2000).unwrap(),
        fee_cap: NonZero::new(1_000_000).unwrap(),
    }
    .data();

    let open_session_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(session_pda, false),
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: open_session_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[open_session_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    // 存入少量费用
    let deposit_amount = 10_000u64;
    let deposit_fee_data = router::instruction::DepositFee {
        amount: deposit_amount,
    }
    .data();

    let deposit_fee_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: deposit_fee_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[deposit_fee_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    // 尝试发送消息，费用超过余额
    let sonic_msg = SonicMsg {
        grid_id,
        nonce: 0,
        ttl_slots: 1000,
        inner: SonicMsgInner::EmbeddedOpcode {
            opcode: EmbeddedOpcode::Swap,
            params: EmbeddedParams {
                in_mint: Pubkey::new_unique(),
                out_mint: Pubkey::new_unique(),
                amount_in: 1000,
                slippage_bps: 50,
                deadline_slot: 10000,
                expected_plan_hash: [0u8; 32],
            },
        },
    };

    let fee_budget = 100_000u64; // 超过存入的金额

    let send_message_data = router::instruction::SendMessage {
        grid_id,
        msg: sonic_msg,
        fee_budget,
    }
    .data();

    let send_message_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(outbox_pda, false),
            AccountMeta::new(session_pda, false),
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: send_message_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[send_message_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);

    match banks_client.process_transaction(transaction).await {
        Ok(_) => {
            println!("❌ 不应该成功！余额不足应该失败");
            panic!("应该因为余额不足而失败");
        }
        Err(e) => {
            println!("✅ 正确拒绝了余额不足的交易: {:?}", e);
        }
    }

    println!("余额不足测试完成！");
}

/// 测试 nonce 不匹配
#[tokio::test]
async fn test_invalid_nonce() {
    println!("测试无效的 nonce...");

    let program_id = Pubkey::from_str(PROGRAM_ID).unwrap();
    let program_test = create_program_test();
    let (mut banks_client, payer, _recent_blockhash) = program_test.start().await;

    let grid_id = 1u64;
    let (session_pda, _) = derive_session_pda(&program_id, &payer.pubkey(), grid_id);
    let (fee_vault_pda, _) = derive_fee_vault_pda(&program_id, &payer.pubkey());
    let (outbox_pda, _) = derive_outbox_pda(&program_id, &payer.pubkey());

    // 设置会话和费用
    let open_session_data = router::instruction::OpenSession {
        grid_id,
        allowed_programs: vec![],
        allowed_opcodes: vec![EmbeddedOpcode::Swap],
        ttl_slots: NonZero::new(2000).unwrap(),
        fee_cap: NonZero::new(1_000_000).unwrap(),
    }
    .data();

    let open_session_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(session_pda, false),
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: open_session_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[open_session_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    let deposit_amount = 500_000u64;
    let deposit_fee_data = router::instruction::DepositFee {
        amount: deposit_amount,
    }
    .data();

    let deposit_fee_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: deposit_fee_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[deposit_fee_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    // 尝试使用错误的 nonce (应该是 0，但使用 999)
    let sonic_msg = SonicMsg {
        grid_id,
        nonce: 999, // 错误的 nonce
        ttl_slots: 1000,
        inner: SonicMsgInner::EmbeddedOpcode {
            opcode: EmbeddedOpcode::Swap,
            params: EmbeddedParams {
                in_mint: Pubkey::new_unique(),
                out_mint: Pubkey::new_unique(),
                amount_in: 1000,
                slippage_bps: 50,
                deadline_slot: 10000,
                expected_plan_hash: [0u8; 32],
            },
        },
    };

    let send_message_data = router::instruction::SendMessage {
        grid_id,
        msg: sonic_msg,
        fee_budget: 100_000,
    }
    .data();

    let send_message_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(outbox_pda, false),
            AccountMeta::new(session_pda, false),
            AccountMeta::new(fee_vault_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: send_message_data,
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(&[send_message_ix], Some(&payer.pubkey()));
    transaction.sign(&[&payer], recent_blockhash);

    match banks_client.process_transaction(transaction).await {
        Ok(_) => {
            println!("❌ 不应该成功！nonce 不匹配应该失败");
            panic!("应该因为 nonce 不匹配而失败");
        }
        Err(e) => {
            println!("✅ 正确拒绝了无效的 nonce: {:?}", e);
        }
    }

    println!("无效 nonce 测试完成！");
}
