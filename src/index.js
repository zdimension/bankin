const {
  BaseKonnector,
  updateOrCreate,
  log,
  cozyClient,
  categorize
} = require('cozy-konnector-libs')
const doctypes = require('cozy-doctypes/dist')
const moment = require('moment')

const BankinApi = require('./bankin-api')

const {
  Document,
  BankAccount,
  BankTransaction,
  BalanceHistory,
  BankingReconciliator
} = doctypes
BankAccount.registerClient(cozyClient)
BalanceHistory.registerClient(cozyClient)
Document.registerClient(cozyClient)

const reconciliator = new BankingReconciliator({ BankAccount, BankTransaction })

const defaultClientId = process.env.DEFAULT_CLIENT_ID
const defaultClientSecret = process.env.DEFAULT_CLIENT_SECRET

module.exports = new BaseKonnector(start)

async function start(fields) {
  let accountData = this.getAccountData()
  log('info', `Current account data: ${JSON.stringify(accountData || {})}`)

  const surchargedFiels = surchargeFields(fields)

  const bankinApi = new BankinApi(surchargedFiels, accountData)
  const { accounts, allOperations } = await bankinApi.fetchAllOperations()
  const now = moment()
  const todayAsString = now.add(1, 'days').format('YYYY-MM-DD')
  const oneMonthAgo = now.subtract(1, 'months').format('YYYY-MM-DD') // so we don't fetch the entire history...
  const categorizedTransactions = await categorize(
    allOperations.filter(o => !o.is_future && o.date < todayAsString && o.date >= oneMonthAgo)
  )

  try {
    const { accounts: savedAccounts } = await reconciliator.save(
      accounts,
      allOperations
    )
    const balances = await fetchBalances(savedAccounts)
    await saveBalances(balances)
  } catch (error) {
    log('error', error)
  }

  try {
    log('info', 'Saving account data...')
    accountData.bankinDeviceId = bankinApi.bankinDeviceId
    await this.saveAccountData(accountData)
  } catch (error) {
    log('error', 'Could not save account data')
    log('error', error)
  }
}

const surchargeFields = fields => {
  if (!(typeof fields.clientId === 'string') || fields.clientId.length === 0) {
    fields.clientId = defaultClientId
  }

  if (
    !(typeof fields.clientSecret === 'string') ||
    fields.clientSecret.length === 0
  ) {
    fields.clientSecret = defaultClientSecret
  }

  return fields
}

const fetchBalances = accounts => {
  const now = moment()
  const todayAsString = now.format('YYYY-MM-DD')
  const currentYear = now.year()

  return Promise.all(
    accounts.map(async account => {
      const history = await getBalanceHistory(currentYear, account._id)
      history.balances[todayAsString] = account.balance

      return history
    })
  )
}

const getBalanceHistory = async (year, accountId) => {
  const index = await cozyClient.data.defineIndex(
    'io.cozy.bank.balancehistories',
    ['year', 'relationships.account.data._id']
  )
  const options = {
    selector: { year, 'relationships.account.data._id': accountId },
    limit: 1
  }
  const [balance] = await cozyClient.data.query(index, options)

  if (balance) {
    log(
      'info',
      `Found a io.cozy.bank.balancehistories document for year ${year} and account ${accountId}`
    )
    return balance
  }

  log(
    'info',
    `io.cozy.bank.balancehistories document not found for year ${year} and account ${accountId}, creating a new one`
  )
  return getEmptyBalanceHistory(year, accountId)
}

const getEmptyBalanceHistory = (year, accountId) => {
  return {
    year,
    balances: {},
    metadata: {
      version: 1
    },
    relationships: {
      account: {
        data: {
          _id: accountId,
          _type: 'io.cozy.bank.accounts'
        }
      }
    }
  }
}

const saveBalances = balances => {
  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id'])
}
