// sync-prices.js
const { createClient } = require('@supabase/supabase-js')
const fetch = require('node-fetch')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PRISYNC_API_KEY = process.env.PRISYNC_API_KEY
const PRISYNC_BASE_URL = 'https://api.prisync.com/v1'

function cleanProductUrl(url) {
  try {
    const urlObj = new URL(url)
    
    // Remove common tracking parameters
    const trackingParams = [
      'country', 'source', 'sv1', 'sv_campaign_id', 'awc', 'sscid',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      'fbclid', 'gclid', 'ref', 'affiliate'
    ]
    
    trackingParams.forEach(param => {
      urlObj.searchParams.delete(param)
    })
    
    return urlObj.toString()
  } catch (error) {
    console.error('Error cleaning URL:', error)
    return url
  }
}

async function fetchPrisyncPriceForUrl(productUrl) {
  try {
    const cleanUrl = cleanProductUrl(productUrl)
    
    const response = await fetch(`${PRISYNC_BASE_URL}/products/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PRISYNC_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: cleanUrl
      })
    })
    
    if (!response.ok) {
      throw new Error(`Prisync API error: ${response.status}`)
    }
    
    const data = await response.json()
    return data
  } catch (error) {
    console.error(`Error fetching price for URL ${productUrl}:`, error)
    throw error
  }
}

async function updateDatabasePrices() {
  // Get all products from database
  const { data: products, error: fetchError } = await supabase
    .from('bags')
    .select('id, product_link, normal_retail_price')
    .not('product_link', 'is', null)
  
  if (fetchError) {
    console.error('Error fetching products from database:', fetchError)
    throw fetchError
  }
  
  console.log(`Found ${products.length} products to update`)
  
  const results = {
    successful: 0,
    failed: 0,
    errors: []
  }
  
  // Process products in batches to avoid rate limiting
  const batchSize = 5
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize)
    
    const batchPromises = batch.map(async (product) => {
      try {
        const prisyncData = await fetchPrisyncPriceForUrl(product.product_link)
        
        // Extract current price - adjust based on actual Prisync API response
        const currentPrice = prisyncData.price || prisyncData.current_price || prisyncData.data?.price
        
        if (currentPrice) {
          const { error: updateError } = await supabase
            .from('bags')
            .update({ 
              normal_retail_price: currentPrice,
              last_price_update: new Date().toISOString()
            })
            .eq('id', product.id)
          
          if (updateError) {
            throw updateError
          }
          
          results.successful++
          console.log(`✓ Updated product ${product.id}: $${currentPrice}`)
        } else {
          throw new Error('No price found in Prisync response')
        }
        
      } catch (error) {
        results.failed++
        results.errors.push({
          product_id: product.id,
          product_link: product.product_link,
          error: error.message
        })
        console.error(`✗ Failed to update product ${product.id}:`, error.message)
      }
    })
    
    await Promise.all(batchPromises)
    
    // Add delay between batches
    if (i + batchSize < products.length) {
      console.log(`Processed batch ${Math.floor(i/batchSize) + 1}, waiting 1 second...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  
  return results
}

async function main() {
  try {
    console.log('🚀 Starting Prisync price sync...')
    
    const results = await updateDatabasePrices()
    
    console.log('\n📊 Sync Results:')
    console.log(`✓ Successful updates: ${results.successful}`)
    console.log(`✗ Failed updates: ${results.failed}`)
    
    if (results.errors.length > 0) {
      console.log('\n❌ Errors:')
      results.errors.forEach(error => {
        console.log(`  - Product ${error.product_id}: ${error.error}`)
      })
    }
    
  } catch (error) {
    console.error('💥 Price sync failed:', error)
    process.exit(1)
  }
}

// Run the script
main()
